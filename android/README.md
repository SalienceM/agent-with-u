# AgentWithU Android

AgentWithU 的 Android 原生客户端，通过 Relay 连接远端执行节点进行 AI 对话。

## 功能特性

- ✅ **Relay 连接**：通过 WebSocket 中继连接远端执行节点，无需本机执行能力
- ✅ **聊天对话**：完整的消息发送与流式接收（逐字输出）
- ✅ **会话管理**：创建、切换、重命名、删除会话
- ✅ **图片上传**：从相册选择图片附加到消息
- ✅ **多模型切换**：在聊天页顶部切换不同的后端模型
- ✅ **Markdown 渲染**：支持粗体、斜体、行内代码、代码块、标题、列表
- ✅ **思考过程展示**：可折叠的 thinking 块
- ✅ **工具调用显示**：展示工具名称与状态
- ✅ **自动重连**：断线后指数退避自动重连
- ✅ **深色主题**：与桌面端一致的深色配色
- ✅ **移动端适配**：竖屏优化、Edge-to-Edge、键盘避让

## 技术栈

- **Kotlin** + **Jetpack Compose**（Material 3）
- **OkHttp** WebSocket 客户端
- **Kotlinx Serialization** JSON 处理
- **DataStore** 设置持久化
- **Navigation Compose** 页面导航
- **Coroutines + StateFlow** 响应式数据流

## 项目结构

```
android/app/src/main/java/com/agentwithu/android/
├── AgentWithUApp.kt          # Application 单例
├── MainActivity.kt           # 入口 Activity
├── AppNavigation.kt          # 页面导航
├── data/
│   └── Models.kt             # 数据模型
├── network/
│   ├── ApiModels.kt          # 网络协议模型
│   └── RelayConnection.kt    # WebSocket + Relay 连接管理
├── repository/
│   └── ChatRepository.kt     # 中央数据仓库
├── ui/
│   ├── theme/                # Material 3 深色主题
│   ├── components/           # 可复用组件
│   │   ├── MessageBubble.kt  # 消息气泡
│   │   ├── ChatInput.kt      # 输入栏
│   │   └── SessionCard.kt    # 会话卡片
│   ├── chat/                 # 聊天页
│   ├── sessions/             # 会话列表页
│   └── settings/             # 设置页
├── util/
│   ├── MarkdownRenderer.kt   # 轻量 Markdown 渲染
│   └── ImageUtil.kt          # 图片 URI → Base64 编码
```

## 构建

### 前置要求

- Android Studio Ladybug (2024.2.1) 或更新版本
- JDK 17+
- Android SDK 35
- Kotlin 2.0.21

### 步骤

1. 用 Android Studio 打开 `android/` 目录
2. 等待 Gradle sync 完成
3. 连接手机或启动模拟器
4. 点击 Run 构建并安装

### 命令行构建

```bash
cd android

# 首次构建前，创建 local.properties 指向 Android SDK 路径
# Windows 示例：
echo sdk.dir=C:\\Users\\<用户名>\\AppData\\Local\\Android\\Sdk > local.properties
# macOS/Linux 示例：
# echo "sdk.dir=/Users/<用户名>/Library/Android/sdk" > local.properties

# 调试包
./gradlew assembleDebug

# 安装包到设备
./gradlew installDebug

# Release 包
./gradlew assembleRelease
```

> **注意**：使用 Android Studio 打开项目时会自动生成 `local.properties`，无需手动创建。

## 使用

1. 首次打开进入设置页（或直接连接，如果之前已配置）
2. 配置 Relay 连接参数：
   - **WebSocket URL**：中继服务器地址，如 `ws://your-server:44360`
   - **Token**：中继认证令牌
   - **设备 ID**：要连接的执行节点 ID
3. 保存并连接
4. 创建会话，开始对话

## 协议兼容

本客户端完全兼容 AgentWithU 的 JSON-RPC over WebSocket 协议：

- **Relay 握手**：`{"t":"hello","token":"...","deviceId":"..."}` → `{"t":"ready"}`
- **JSON-RPC**：`{"id":"r1","method":"...","params":[...]}` → `{"id":"r1","result":"..."}`
- **推送事件**：`{"event":"streamDelta","data":"..."}`, `{"event":"sessionUpdated","data":"..."}`

## 已知限制

- 不支持 Loop 可视化（设计裁剪）
- 不支持目录同步（设计裁剪）
- 不支持执行节点管理（设计裁剪）
- 工具调用详情展示为简化版
