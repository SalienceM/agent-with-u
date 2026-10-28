#!/usr/bin/env bash
# 只在专属 Docker volume 中构建固定源码，不挂载用户 home/项目为可写目录。
set -euo pipefail
test "${AWU_DSH_BUILD:-}" = '1'
case "${1:-}" in
  prepare)
    test ! -e /work/source
    tar -xf /input/source.tar -C /work
    cd /work/source
    test "$(node -p "require('./package.json').version")" = '0.2.1-rc.3'
    test "$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)" = '911b049924e8256d8d6e684235cf935ca75b28fd0dd46f0c3b316a51c2cf5dc1'
    mkdir -p /work/tools /work/node/include
    cp -a /usr/local/include/node /work/node/include/node
    npm install --prefix /work/tools pnpm@11.28.5
    export PATH="/work/tools/node_modules/.bin:$PATH"
    export CI=true DSH_TELEMETRY_DISABLED=1 DSH_BUILD_CLIENT_PROFILE=official
    pnpm install --frozen-lockfile
    ;&
  compile)
    cd /work/source
    test "$(git rev-parse HEAD)" = '1f81c047fc48fa190a683e469daa699857e9afe8'
    export PATH="/work/tools/node_modules/.bin:$PATH"
    export CI=true DSH_TELEMETRY_DISABLED=1 DSH_BUILD_CLIENT_PROFILE=official
    pnpm run build:artifacts
    ;&
  configure)
    cd /work/source
    mkdir -p /work/node/bin
    cp /usr/local/bin/node /work/node/bin/node
    if test ! -d /work/tools/npm; then
      cp -a /usr/local/lib/node_modules/npm /work/tools/npm
    fi
    addon="$(realpath packages/subprocess/subprocess-local/node_modules/node-pty)"
    cd "$addon"
    node /work/tools/npm/node_modules/node-gyp/bin/node-gyp.js configure --nodedir=/work/node
    ;;
  native)
    cd /work/source
    export PATH="/work/node/bin:$PATH"
    addon="$(realpath packages/subprocess/subprocess-local/node_modules/node-pty)"
    # 使用 -B 强制重编译，不递归删除任何目录。
    make -B -C "$addon/build" -j2 BUILDTYPE=Release
    cc -std=c11 -O2 -Wall -Wextra -Werror -fPIC -fvisibility=hidden -DNAPI_VERSION=8 \
      -I /work/node/include/node -shared \
      -o native/system/packages/linux-x64/bin/glibc/system.node \
      native/system/packages/entry/src/flock.c
    for binary in "$addon/build/Release/pty.node" native/system/packages/linux-x64/bin/glibc/system.node; do
      maximum="$(readelf --version-info "$binary" | sed -n 's/.*Name: GLIBC_\([0-9.]*\).*/\1/p' | sort -V | tail -1)"
      test -n "$maximum"
      test "$(printf '%s\n' "$maximum" 2.28 | sort -V | tail -1)" = '2.28'
      printf '%s GLIBC_%s\n' "$binary" "$maximum"
    done
    ;;
  package)
    cd /work/source
    export PATH="/work/tools/node_modules/.bin:$PATH"
    export CI=true DSH_TELEMETRY_DISABLED=1 DSH_BUILD_CLIENT_PROFILE=official
    pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets=node24-linux-x64 --skip-build
    ;;
  wheels)
    cd /work/source
    python=/opt/python/cp310-cp310/bin/python
    "$python" -m pip install --target /work/python-tools uv==0.11.23
    export PATH="/work/python-tools/bin:$PATH"
    "$python" scripts/build-python-release.py --package runtime --platform linux-x64 \
      --runtime-exe /work/source/dist-exe/deepseek-harness-sdk-runtime-linux-x64 --output-dir /output
    ;;
  verify-install)
    /opt/python/cp310-cp310/bin/python -m venv /work/verify-env
    /work/verify-env/bin/python -m pip install \
      /input/wheels/deepseek_harness_sdk-0.2.1rc3-py3-none-any.whl \
      /input/wheels/deepseek_harness_runtime_bin-0.2.1rc3-py3-none-manylinux_2_28_x86_64.whl \
      pydantic==2.13.4
    ;;
  verify)
    cd /input/project
    export PYTHONDONTWRITEBYTECODE=1 AWU_TEST_NATIVE_DSH=1
    export AWU_TEST_DSH_BRIDGE=/input/project/build/deepseek-harness/bridge/lib/index.mjs
    timeout 60 /work/verify-env/bin/python -m unittest \
      tests.test_deepseek_harness_distribution tests.test_deepseek_harness_sdk_contract \
      tests.test_deepseek_harness_native -v
    ;;
  *) printf 'Unknown build phase\n' >&2; exit 2 ;;
esac
