# AgentWithU 后端镜像
#
# 只打包 Python 后端（WS 44321 + HTTP API 44322）。
# 前端静态产物由 awu-web (nginx) 容器托管，不在本镜像内。
#
# 构建：docker compose -f deploy/docker-compose.example.yml build
# 单独构建：docker build -f deploy/Dockerfile -t agent-with-u-backend .

FROM python:3.11-slim

ARG AGENT_WITH_U_BUILD_ID=dev
ARG AGENT_WITH_U_VERSION=dev
LABEL io.agentwithu.component="backend" \
      io.agentwithu.updatable="true" \
      io.agentwithu.build-id="${AGENT_WITH_U_BUILD_ID}" \
      io.agentwithu.version="${AGENT_WITH_U_VERSION}"

# Claude/Codex CLI 都依赖 Node.js。执行节点默认同时提供两套官方 CLI，
# 避免 Docker 节点创建 Codex Backend 后才发现宿主镜像里没有 codex。
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git nodejs npm \
    && npm install -g \
       "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
       "@openai/codex@${CODEX_VERSION}" \
    && claude --version \
    && codex --version \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 用锁定版本清单安装依赖：pip 零回溯，弱网环境下也能稳定解析
COPY deploy/requirements-docker.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements-docker.txt

# 后端源码 + 内置 skills
COPY src ./src
COPY skills ./skills

# 数据目录（compose 里把宿主目录 bind-mount 到这里）
ENV AGENT_WITH_U_DATA_ROOT=/app/data
RUN mkdir -p /app/data

EXPOSE 44321 44322

CMD ["python", "-m", "src.ws_main"]
