# AgentWithU 后端镜像
#
# 只打包 Python 后端（WS 44321 + HTTP API 44322）。
# 前端静态产物由 awu-web (nginx) 容器托管，不在本镜像内。
#
# 构建：docker compose -f deploy/docker-compose.example.yml build
# 单独构建：docker build -f deploy/Dockerfile -t agent-with-u-backend .

FROM node:24.10.0-bookworm-slim AS node-runtime

# 干净 Git checkout 也能构建；不 COPY 开发机被忽略的 build/ 制品。
FROM python:3.11-slim-bookworm AS harness-source
COPY --from=node-runtime /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential \
    && pip install --no-cache-dir uv==0.11.23 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/awu-harness
COPY deploy/harness-adapter/package.json deploy/harness-adapter/package-lock.json ./
RUN npm ci
WORKDIR /work/project
COPY deploy/deepseek-harness.lock.json deploy/deepseek-harness.build-linux.json deploy/deepseek-harness.external.json ./deploy/
RUN git init /opt/harness-source \
    && git -C /opt/harness-source fetch --depth 1 https://github.com/deepseek-ai/deepseek-harness \
       "$(python -c "import json; print(json.load(open('deploy/deepseek-harness.lock.json'))['commit'])")" \
    && git -C /opt/harness-source checkout --detach FETCH_HEAD
COPY src ./src
COPY scripts ./scripts
COPY tools/deepseek-harness ./tools/deepseek-harness
COPY frontend/src/types/harnessImageContract.json ./frontend/src/types/harnessImageContract.json

FROM harness-source AS harness-build
RUN python scripts/build_docker_harness.py --source /opt/harness-source \
    --modules /opt/awu-harness/node_modules --node /usr/local/bin/node \
    && npm prune --omit=dev --prefix /opt/awu-harness

FROM python:3.11-slim-bookworm

ARG AGENT_WITH_U_BUILD_ID=dev
ARG AGENT_WITH_U_VERSION=dev
LABEL io.agentwithu.component="backend" \
      io.agentwithu.updatable="true" \
      io.agentwithu.build-id="${AGENT_WITH_U_BUILD_ID}" \
      io.agentwithu.version="${AGENT_WITH_U_VERSION}"

# Claude/Codex/Qwen CLI 都依赖 Node.js；Qwen Code 要求 Node.js 20+。
# 从官方 Node 镜像复制运行时，避免 Debian 自带的旧 Node 让镜像能构建却不能运行 Qwen。
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG QWEN_CODE_VERSION=latest
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git libatomic1 bubblewrap \
    && npm install -g \
       "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
       "@openai/codex@${CODEX_VERSION}" \
       "@qwen-code/qwen-code@${QWEN_CODE_VERSION}" \
    && node --version \
    && claude --version \
    && codex --version \
    && qwen --version \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 用锁定版本清单安装依赖：pip 零回溯，弱网环境下也能稳定解析
# 与运行时使用同一个 python 做完整 API 探针；缺包或 SDK 版本不兼容时直接终止构建。
COPY deploy/requirements-docker.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements-docker.txt \
    && python -c "from qwen_code_sdk import ProcessExitError, is_sdk_assistant_message, is_sdk_partial_assistant_message, is_sdk_result_message, query"

# 后端源码 + 内置 skills
COPY src ./src
COPY skills ./skills

# 构建期准备固定 CLI + 轻量 SDK/桥，聊天时不安装、不下载，也不修改用户 Backend。
COPY --from=harness-build /opt/awu-harness /opt/awu-harness
COPY --from=harness-build /work/project/build/deepseek-harness ./build/deepseek-harness
COPY deploy/deepseek-harness.external.json ./deploy/deepseek-harness.external.json
ENV PATH="/opt/awu-harness/node_modules/.bin:${PATH}" \
    AGENT_WITH_U_HARNESS_EXTERNAL=1
RUN pip install --no-index --no-deps ./build/deepseek-harness/wheels/*.whl \
    && python -c "import src.ws_main; from src.backend.deepseek_harness_distribution import verify_adapter; verify_adapter(); from src.backend.deepseek_harness_cli import resolve_external_cli; resolve_external_cli()"

# 数据目录（compose 里把宿主目录 bind-mount 到这里）
ENV AGENT_WITH_U_DATA_ROOT=/app/data
RUN mkdir -p /app/data

EXPOSE 44321 44322

CMD ["python", "-m", "src.ws_main"]
