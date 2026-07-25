import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function globalSetup(): void {
  const repoRoot = path.resolve(__dirname, '../../..');
  const profile = process.env.HOME_QA_PROFILE === 'stress' ? 'stress' : 'typical';
  execFileSync(
    'python',
    [path.join(repoRoot, 'scripts', 'home_qa_fixture.py'), '--profile', profile],
    { cwd: repoRoot, stdio: 'inherit' },
  );
}
