import asyncio
import codecs
import hashlib
import json
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.backend.engine_workbench import WorkbenchError
from src.backend.workspace_documents import decode_document, encode_document, read_document, safe_document_path
from tests.engine_workbench_fixtures import EngineFixture


class DocumentReadTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.session = self.fixture.session()
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {self.session.id: self.session}

    async def asyncSetUp(self):
        self.token = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.identity = self.bridge._workbench_identity(self.session.id)

    async def asyncTearDown(self):
        for task in getattr(self.bridge, '_document_read_tasks', set()).copy():
            await asyncio.gather(task, return_exceptions=True)
        _REQUEST_OWNER_ID.reset(self.token)

    def file(self, data, relative='code.txt'):
        path = self.fixture.require_path(self.fixture.workspace / relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    async def read(self, relative='code.txt', preview=False, expected=None):
        return json.loads(await self.bridge._rpc_workspaceDocumentRead(self.session.id,
            json.dumps(expected if expected is not None else self.identity.to_dict()), relative, preview))

    async def test_lossless_encodings_bom_eol_and_byte_versions(self):
        for marker, codec in ((b'', 'utf-8'), (codecs.BOM_UTF8, 'utf-8'),
                (codecs.BOM_UTF16_LE, 'utf-16-le'), (codecs.BOM_UTF16_BE, 'utf-16-be')):
            for newline in ('\n', '\r\n', '\r', ''):
                with self.subTest(codec=codec, marker=marker, newline=newline):
                    data = marker + f'中文🙂{newline}second'.encode(codec)
                    self.file(data)
                    result = await self.read()
                    self.assertTrue(result['complete'])
                    self.assertTrue(result['editable'])
                    self.assertEqual(result['version']['sha256'], hashlib.sha256(data).hexdigest())
                    self.assertEqual(result['version']['byteLength'], len(data))
                    self.assertEqual(encode_document(result['text'], result), data)
                    self.assertEqual(result['document']['workspace'], self.identity.to_dict())

    async def test_large_and_explicit_preview_never_get_writable_baselines(self):
        self.file(b'a' * 4096)
        with patch('src.backend.workspace_documents.MAX_DOCUMENT_BYTES', 1024), \
                patch('src.backend.workspace_documents.PREVIEW_BYTES', 100):
            result = await self.read()
            self.assertEqual(result['readByteLength'], 100)
            self.assertEqual(result['byteLength'], 4096)
            self.assertEqual(result['reasonCode'], 'too_large')
            self.assertIsNone(result['version'])
            self.assertFalse(result['editable'])
            self.file(b'b' * 200)
            result = await self.read(preview=True)
            self.assertEqual(result['reasonCode'], 'preview_only')
            self.assertFalse(result['complete'])
            self.assertIsNone(result['version'])
            self.assertTrue((await self.read())['editable'])

    async def test_binary_broken_mixed_and_specialized_content_readonly(self):
        cases = [(b'a\0b', 'binary'), (b'bad\xfftext', 'invalid_encoding'),
                 ('bad\ufffdtext'.encode(), 'replacement_character'),
                 (b'a\r\nb\nc', 'mixed_eol'), (codecs.BOM_UTF32_LE + b'aaaa', 'unsupported_encoding')]
        for data, reason in cases:
            self.file(data)
            result = await self.read()
            self.assertFalse(result['editable'])
            self.assertEqual(result['reasonCode'], reason)
        self.file(b'%PDF-1.4\nASCII body', 'not-text.pdf')
        self.assertEqual((await self.read('not-text.pdf'))['reasonCode'], 'specialized_preview')

    async def test_preview_mid_unicode_does_not_insert_replacement_or_enable_editing(self):
        self.file('中🙂'.encode())
        with patch('src.backend.workspace_documents.PREVIEW_BYTES', 5):
            result = await self.read(preview=True)
        self.assertEqual(result['text'], '中')
        self.assertFalse(result['editable'])
        self.assertIsNone(result['version'])

    async def test_paths_identity_and_empty_file(self):
        self.file(b'')
        self.assertTrue((await self.read())['editable'])
        for path in ('../home/file', '/absolute', 'C:/absolute', 'code.txt:stream', 'NUL', 'code.txt.'):
            self.assertEqual((await self.read(path))['status'], 'error')
        self.assertEqual((await self.read(expected={}))['reasonCode'], 'stale_workspace')
        self.assertEqual((await self.read('missing'))['reasonCode'], 'file_unavailable')
        token = _REQUEST_OWNER_ID.set('wrong-user')
        try:
            with self.assertRaises(PermissionError):
                await self.read()
        finally:
            _REQUEST_OWNER_ID.reset(token)

    async def test_actual_handle_is_rechecked_before_contents_are_read(self):
        self.file(b'private')
        with patch('src.backend.workspace_documents._descriptor_path', return_value=self.fixture.home / 'other'):
            result = await self.read()
        self.assertEqual(result['reasonCode'], 'file_changed_during_read')
        self.assertNotIn('text', result)

    async def test_hardlinked_files_are_not_writable_documents(self):
        path = self.file(b'one')
        os.link(path, self.fixture.workspace / 'alias.txt')
        self.assertEqual((await self.read())['reasonCode'], 'hardlinked_file')

    async def test_late_read_rechecks_workspace_without_returning_old_content(self):
        self.file(b'old namespace')
        entered, finish = threading.Event(), threading.Event()
        def delayed(*args, **kwargs):
            entered.set()
            if not finish.wait(3):
                raise RuntimeError('test wait expired')
            return read_document(*args, **kwargs)
        with patch('src.backend.workspace_documents.read_document', side_effect=delayed):
            task = asyncio.create_task(self.read())
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            self.session.working_dir = str(self.fixture.home)
            finish.set()
            result = await task
        self.assertEqual(result['reasonCode'], 'stale_workspace')
        self.assertNotIn('text', result)

    def test_encoder_rejects_corrupt_and_oversized_input(self):
        meta = decode_document(b'hello\r\n', complete=True)
        for text in ('bad\0text', 'bad\ufffdtext', '\ud800'):
            with self.assertRaises(WorkbenchError):
                encode_document(text, meta)
        with patch('src.backend.workspace_documents.MAX_DOCUMENT_BYTES', 10):
            with self.assertRaisesRegex(WorkbenchError, 'too_large'):
                encode_document('中文字🙂', meta)

    async def test_explicit_cancel_discards_only_that_read_without_releasing_worker_slot(self):
        self.file(b'content')
        entered, finish = threading.Event(), threading.Event()
        def delayed(*args, **kwargs):
            entered.set()
            finish.wait(3)
            return read_document(*args, **kwargs)
        identity = json.dumps(self.identity.to_dict())
        with patch('src.backend.workspace_documents.read_document', side_effect=delayed):
            task = asyncio.create_task(self.bridge._rpc_workspaceDocumentRead(self.session.id, identity,
                'code.txt', False, 'read-1'))
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            wrong = self.identity.to_dict()
            wrong['workspaceRevision'] = 'a' * 64
            denied = json.loads(self.bridge._rpc_workspaceDocumentReadCancel(self.session.id, json.dumps(wrong), 'read-1'))
            self.assertEqual(denied['reasonCode'], 'stale_workspace')
            cancelled = json.loads(self.bridge._rpc_workspaceDocumentReadCancel(self.session.id, identity, 'read-1'))
            self.assertTrue(cancelled['cancelRequested'])
            self.assertEqual(self.bridge._document_read_count, 1)
            finish.set()
            result = json.loads(await task)
        self.assertEqual(result['reasonCode'], 'read_cancelled')
        self.assertNotIn('text', result)
        self.assertEqual(self.bridge._document_read_count, 0)
        self.assertTrue((await self.read())['editable'])

    async def test_refresh_is_bounded_to_explicit_documents_and_contains_no_text(self):
        self.file(b'old')
        self.file(b'second', 'b.txt')
        a = await self.read()
        b = await self.read('b.txt')
        self.file(b'new')
        payload = [{'relativePath': 'code.txt', 'version': a['version']},
                   {'relativePath': 'b.txt', 'version': b['version']}]
        with patch('src.backend.workspace_documents.read_document', wraps=read_document) as reads:
            result = json.loads(await self.bridge._rpc_workspaceDocumentRefresh(self.session.id,
                json.dumps(self.identity.to_dict()), json.dumps(payload)))
            self.assertEqual(reads.call_count, 2)
        self.assertEqual([doc['status'] for doc in result['documents']], ['changed', 'unchanged'])
        self.assertNotIn('text', json.dumps(result))
        invalid = json.loads(await self.bridge._rpc_workspaceDocumentRefresh(self.session.id,
            json.dumps(self.identity.to_dict()), json.dumps(payload * 9)))
        self.assertEqual(invalid['reasonCode'], 'invalid_request')

    async def test_late_refresh_does_not_return_old_namespace_versions(self):
        self.file(b'old')
        entered, finish = threading.Event(), threading.Event()
        def delayed(*args, **kwargs):
            entered.set()
            finish.wait(3)
            return read_document(*args, **kwargs)
        with patch('src.backend.workspace_documents.read_document', side_effect=delayed):
            task = asyncio.create_task(self.bridge._rpc_workspaceDocumentRefresh(self.session.id,
                json.dumps(self.identity.to_dict()), '[{"relativePath":"code.txt","version":null}]'))
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            self.session.working_dir = str(self.fixture.home)
            finish.set()
            result = json.loads(await task)
        self.assertEqual(result['reasonCode'], 'stale_workspace')
        self.assertNotIn('documents', result)
