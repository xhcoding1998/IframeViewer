# Iframe 检测器 - Chrome Extension (MV3)

扫描当前页面所有 `<iframe>` 元素，解析 src URL 参数，并对 iframe 内容进行截图快照预览。

## 核心功能

| 功能 | 说明 |
|------|------|
| **扫描 iframe** | 一键检测当前页面全部 `<iframe>`，显示 src、尺寸等信息 |
| **URL 参数解析** | 将 src 自动拆分为 Base URL + 查询参数表格，支持一键复制 |
| **截图快照** | 自动将 iframe 滚动到视口，调用 `captureVisibleTab` 截图后精确裁剪出 iframe 区域 |
| **属性信息** | 展示 id / name / title / 尺寸 / 域名 / 协议等完整属性 |
| **保存图片** | 截图后可直接下载 PNG |

## 安装方法

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目根目录（含 `manifest.json` 的文件夹）

## 使用流程

1. 打开任意含有 `<iframe>` 的页面
2. 点击扩展图标打开弹窗
3. 点击「**扫描 iframe**」按钮
4. 点击任意 iframe 卡片上的「**截取快照**」→ 自动截图裁剪
5. 切换「URL 参数」标签查看完整参数表，可逐项复制

## 文件结构

```
├── manifest.json     MV3 配置
├── background.js     Service Worker（tab 截图）
├── content.js        Content Script（iframe 扫描 + 滚动定位）
├── popup.html        弹窗 UI
├── popup.css         浅色主题样式
├── popup.js          弹窗逻辑（参数解析 + 图像裁剪）
└── icons/            SVG 图标
```

## 注意事项

- **截图权限**：`captureVisibleTab` 仅能截取当前可见视口，插件会自动滚动 iframe 到屏幕中央再截图
- **srcdoc**：对使用内联 HTML 的 `srcdoc` iframe，无法解析 URL 参数，但仍可截图
- **跨域 iframe**：无论跨域与否均可截图（截的是渲染后的视觉快照，非 DOM 内容）
