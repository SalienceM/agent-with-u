# AgentWithU 后端镜像
#
# 只打包 Python 后端（WS 44321 + HTTP API 44322）。
# 前端静态产物由 awu-web (nginx) 容器托管，不在本镜像内。
#
# 构建：docker compose -f deploy/docker-compose.example.yml build
# 单独构建：docker build -f deploy/Dockerfile -t agent-with-u-backend .

FROM node:20-bookworm-slim AS node-runtime

FROM python:3.11-slim

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
    && apt-get install -y --no-install-recommends ca-certificates curl git libatomic1 \
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

# 数据目录（compose 里把宿主目录 bind-mount 到这里）
ENV AGENT_WITH_U_DATA_ROOT=/app/data
RUN mkdir -p /app/data

EXPOSE 44321 44322

CMD ["python", "-m", "src.ws_main"]
