# G-Player Proxy

[中文](#中文说明) | [English](#english)

---

## 中文说明

### 🎵 简介

G-Player Proxy 是一个 SillyTavern 服务端插件，为 G-Player 音乐播放器提供多音源代理支持。

> ⚠️ **重要提示**：本插件是 [SillyTavern-TypingIndicatorThemes](https://github.com/Sanjs333/SillyTavern-TypingIndicatorThemes) 的**必需后端组件**，必须配合主插件使用，单独安装无法工作。

### 🚀 安装

#### 前置要求

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) 已安装
- [SillyTavern-TypingIndicatorThemes](https://github.com/Sanjs333/SillyTavern-TypingIndicatorThemes) 已安装
- Node.js 18+
- Git（推荐）

#### 一键安装（推荐）

请根据使用系统执行对应的命令：

**🪟 Windows (PowerShell)**

```powershell
cd SillyTavern && (Get-Content config.yaml) -replace 'enableServerPlugins: false', 'enableServerPlugins: true' | Set-Content config.yaml && cd plugins && git clone https://github.com/Sanjs333/g-player-proxy.git && cd g-player-proxy && npm install && cd ../.. && echo "安装完成！请重启 SillyTavern"
```

**🐧 Linux / macOS**

```bash
cd SillyTavern && sed -i 's/enableServerPlugins: false/enableServerPlugins: true/' config.yaml && cd plugins && git clone https://github.com/Sanjs333/g-player-proxy.git && cd g-player-proxy && npm install && echo "安装完成！请重启 SillyTavern"
```

**📱 Termux (Android)**

```bash
cd SillyTavern && sed -i 's/enableServerPlugins: false/enableServerPlugins: true/' config.yaml && cd plugins && git clone https://github.com/Sanjs333/g-player-proxy.git && cd g-player-proxy && npm install && echo "安装完成！请重启 SillyTavern"
```

#### 手动安装

如果一键命令失败，请按以下步骤手动安装：

**第一步：启用服务端插件**

1. 打开 SillyTavern 根目录下的 `config.yaml` 文件
2. 找到 `enableServerPlugins: false`
3. 将 `false` 改为 `true`
4. 保存文件

**第二步：下载插件**

方式一：使用 Git（推荐）
```bash
cd SillyTavern/plugins
git clone https://github.com/Sanjs333/g-player-proxy.git
cd g-player-proxy
npm install
```

方式二：手动下载
1. 前往 [插件仓库](https://github.com/Sanjs333/g-player-proxy)
2. 点击绿色的 `Code` 按钮 → `Download ZIP`
3. 解压后将文件夹放入 `SillyTavern/plugins/` 目录
4. 在插件目录内打开终端，执行 `npm install`

**第三步：重启 SillyTavern**

关闭并重新启动 SillyTavern。

### ✅ 验证安装

启动后在控制台看到以下信息表示安装成功：

```
[G-Player Proxy] ✓ 已启动
```

### ❓ 常见问题

| 问题 | 解决方案 |
|-----|---------|
| 没有看到启动信息 | 检查 `config.yaml` 中 `enableServerPlugins` 是否为 `true` |
| `git` 命令不存在 | 请先安装 Git：https://git-scm.com/downloads |
| `npm` 命令不存在 | 请先安装 Node.js：https://nodejs.org/ |
| 文件夹结构不对 | 确保路径为 `SillyTavern/plugins/g-player-proxy/index.js` |
| macOS 的 sed 报错 | 使用 `sed -i '' 's/...'`（加空引号）或安装 gnu-sed |
| 音乐无法播放 | 检查网络连接，部分音源可能需要代理 |

### 🔗 相关链接

- 主插件：[SillyTavern-TypingIndicatorThemes](https://github.com/Sanjs333/SillyTavern-TypingIndicatorThemes)

---

## English

### 🎵 Introduction

G-Player Proxy is a SillyTavern server plugin that provides multi-source music proxy support for the G-Player music player.

> ⚠️ **Important**: This plugin is a **required backend component** for [SillyTavern-TypingIndicatorThemes](https://github.com/Sanjs333/SillyTavern-TypingIndicatorThemes). It must be used together with the main plugin and will not work standalone.

### 🚀 Installation

#### Prerequisites

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) installed
- [SillyTavern-TypingIndicatorThemes](https://github.com/Sanjs333/SillyTavern-TypingIndicatorThemes) installed
- Node.js 18+
- Git (recommended)

#### One-Click Installation (Recommended)

Run the command for your operating system:

**🪟 Windows (PowerShell)**

```powershell
cd SillyTavern && (Get-Content config.yaml) -replace 'enableServerPlugins: false', 'enableServerPlugins: true' | Set-Content config.yaml && cd plugins && git clone https://github.com/Sanjs333/g-player-proxy.git && cd g-player-proxy && npm install && cd ../.. && echo "Installation complete! Please restart SillyTavern"
```

**🐧 Linux / macOS**

```bash
cd SillyTavern && sed -i 's/enableServerPlugins: false/enableServerPlugins: true/' config.yaml && cd plugins && git clone https://github.com/Sanjs333/g-player-proxy.git && cd g-player-proxy && npm install && echo "Installation complete! Please restart SillyTavern"
```

**📱 Termux (Android)**

```bash
cd SillyTavern && sed -i 's/enableServerPlugins: false/enableServerPlugins: true/' config.yaml && cd plugins && git clone https://github.com/Sanjs333/g-player-proxy.git && cd g-player-proxy && npm install && echo "Installation complete! Please restart SillyTavern"
```

#### Manual Installation

If the one-click command fails, follow these steps:

**Step 1: Enable Server Plugins**

1. Open `config.yaml` in your SillyTavern root directory
2. Find `enableServerPlugins: false`
3. Change `false` to `true`
4. Save the file

**Step 2: Download the Plugin**

Option A: Using Git (Recommended)
```bash
cd SillyTavern/plugins
git clone https://github.com/Sanjs333/g-player-proxy.git
cd g-player-proxy
npm install
```

Option B: Manual Download
1. Go to the [plugin repository](https://github.com/Sanjs333/g-player-proxy)
2. Click the green `Code` button → `Download ZIP`
3. Extract and place the folder in `SillyTavern/plugins/`
4. Open terminal in the plugin directory and run `npm install`

**Step 3: Restart SillyTavern**

Close and restart SillyTavern.

### ✅ Verify Installation

If you see the following message in the console, the installation was successful:

```
[G-Player Proxy] ✓ 已启动
```

### ❓ Troubleshooting

| Issue | Solution |
|-------|----------|
| No startup message | Check if `enableServerPlugins` is `true` in `config.yaml` |
| `git` command not found | Install Git: https://git-scm.com/downloads |
| `npm` command not found | Install Node.js: https://nodejs.org/ |
| Wrong folder structure | Ensure path is `SillyTavern/plugins/g-player-proxy/index.js` |
| sed error on macOS | Use `sed -i '' 's/...'` (with empty quotes) or install gnu-sed |
| Music won't play | Check network connection; some sources may require proxy |

### 🔗 Related Links

- Main Plugin: [SillyTavern-TypingIndicatorThemes](https://github.com/Sanjs333/SillyTavern-TypingIndicatorThemes)