# 🎵 项目架构与开发指南：沉浸式本地专辑播放器

## 1. 项目愿景与核心原则
本项目是一个专注于“以专辑为单位”的沉浸式本地音乐播放器。依靠预先生成的静态 JSON 数据驱动，注重视觉交互、3D 空间感和无缝播放体验。

**开发核心原则（渐进式增强）：**
1. **逻辑先行，特效后置：** 在前期的开发迭代中，所有的 3D 视角转换、CD 弹出、流体背景等复杂动画，**一律使用最简单的 CSS 平移 (`translate`) 或透明度 (`opacity`) 切换作为占位符**。
2. **数据驱动 UI：** 必须优先打通“Fetch 获取 JSON -> 构建 DOM -> 响应式播放”的核心链路。
3. **模块化解耦：** UI 渲染、音频控制、动画计算必须严格分离，确保后期替换复杂动画时不需要重构核心业务逻辑。

---

## 2. 目录结构规范

```text
/local-music-player
├── index.html               # 唯一的 HTML 入口，定义完整的 DOM 骨架
├── css/
│   ├── variables.css        # 全局 CSS 变量（主题色、Z-index 层级、基础间距）
│   ├── layout.css           # 基础布局（Flexbox/Grid 占位）
│   ├── components.css       # 独立 UI 组件样式（进度条、按钮、搜索框）
│   └── animations.css       # 动画文件（前期为简单占位，后期替换为 3D/复杂动画）
├── js/
│   ├── main.js              # 初始化入口，协调各模块
│   ├── core/
│   │   ├── dataLoader.js    # 核心！负责通过 fetch() 加载与解析本地 JSON 数据
│   │   ├── audioEngine.js   # 基于 Web Audio API 的音频引擎（处理无缝播放）
│   │   └── state.js         # 全局状态管理（当前所在界面、当前播放曲目等）
│   ├── ui/
│   │   ├── viewManager.js   # 控制主界面与播放界面的 DOM 切换/显隐
│   │   └── components.js    # 具体 UI 元素的事件绑定（进度条拖拽、CD 旋转）
│   └── utils/
│       └── colorExtractor.js# 专辑封面色彩提取与流体背景算法
├── data/                    # 静态数据与封面源
│   ├── albums.json          # 包含所有专辑简要信息的总表
│   ├── albums/              # 存放单张专辑详细数据的目录
│   └── covers/              # 存放专辑封面图片的目录
└── music/                   # 存放实际 MP3 文件的目录
3. 数据层级与加载逻辑 (dataLoader.js)
系统采用两级 JSON 架构以优化性能，前端必须使用 fetch() 方法通过 XHR 加载这些静态配置。

3.1 第一级：宏观列表 albums.json
软件启动时加载，用于在主界面构建 Cover Flow 专辑墙。

JSON
[
  {
    "id": "album_001",
    "title": "Random Access Memories",
    "artist": "Daft Punk",
    "cover_url": "./data/covers/album_001.jpg",
    "detail_url": "./data/albums/album_001.json"
  }
]
3.2 第二级：微观详情 album_xxx.json
当用户点击某张专辑准备进入播放界面时，通过 detail_url 发起 Fetch 请求加载。注意：数据中已经预先计算好了每首歌在整张专辑大进度条中的 start_time，前端无需重复计算。

JSON
{
  "id": "album_001",
  "title": "Random Access Memories",
  "artist": "Daft Punk",
  "cover_url": "./data/covers/album_001.jpg",
  "total_duration": 4465.2, 
  "tracks": [
    {
      "track_number": 1,
      "title": "Give Life Back to Music",
      "artist": "Daft Punk",
      "file_url": "./music/Daft Punk - RAM/01 Give Life Back to Music.mp3",
      "duration": 274.5,
      "start_time": 0.0
    },
    {
      "track_number": 2,
      "title": "The Game of Love",
      "artist": "Daft Punk",
      "file_url": "./music/Daft Punk - RAM/02 The Game of Love.mp3",
      "duration": 321.7,
      "start_time": 274.5 
    }
  ]
}
4. 核心功能实现路径 (Phase 1: 占位与逻辑框架)
4.1 大进度条与无缝播放 (audioEngine.js)
视觉层： 进度条需设计为左右圆角、歌曲交界处直角断开的样式（根据 JSON 中的时长按比例划分断点）。

逻辑定位： 当用户点击大进度条的某个位置（如 300 秒），算法只需遍历 JSON 的 tracks 数组，找到对应区间（例如落在第二首），立刻加载该 mp3 文件，并通过计算差值（300 - 274.5 = 25.5s）定位到该单曲的播放位置。

无缝播放 (Gapless)： 必须使用 Web Audio API，在当前歌曲结束前提前解码并加载下一首歌曲的 Buffer，以消除传统的切换间隙。

4.2 界面状态切换 (Main View <-> Playback View)
建立两个主要的 DOM 容器：<div id="main-view"> 和 <div id="playback-view">。

前期占位： 点击中心专辑时，暂时直接使用 display: none / block 或简单的 opacity 渐变完成界面切换。

5. 视觉与动画升级指南 (Phase 2: 复杂动效注入)
当 JSON 读取和播放逻辑跑通后，按照以下指南在 animations.css 和相关 JS 中注入最终特效：

5.1 主界面 Cover Flow 舞台
布局： 为外层容器添加 perspective: 1000px，定义 3D 摄像机距离。

动画： 监听键盘/拖拽事件，更新中心索引。使用 CSS transform: rotateY(deg) translateZ(px) translateX(px) 计算两侧专辑的倾斜度和位置。越远离中心，rotateY 角度越大。

交互特效： * 搜索条：Spotlight 风格，绝对定位，配合毛玻璃效果 backdrop-filter: blur(10px)。

中心专辑 Hover：中心专辑 transform: translateX(-5%)，底层预留的 CD DOM 露出边缘。

底部 Hover：CD 机从 transform: translateY(100%) 升起，需带有一点带有俯视视角的 rotateX 属性。

5.2 史诗级转场动画 (镜头视角模拟)
不使用真正的 3D 引擎，而是通过移动整个场景容器来模拟摄像机运动。

触发点击后：

两侧专辑加上类名，触发 translateX 飞出屏幕。

场景主容器执行 CSS transform: rotateX(45deg) scale(1.5) 模拟镜头向下俯视和拉近。

中心专辑滑出，CD 元素改变层级并执行从上到下的 translateY 掉落动画。

底部的 CD 机移除 rotateX，移动到屏幕正中央，等待 CD 掉入后，触发玻璃盖子的旋转闭合动画。

5.3 沉浸式动态背景 (colorExtractor.js)
颜色提取： 加载专辑详情时，将封面绘制到离屏 <canvas>，提取出 Top 3 颜色。

背景渲染： * 占比最大的颜色设置为 body 的 background-color。

使用全屏 <canvas> 或特殊的 CSS <div> 承载另外两种颜色，生成几何图形，并利用数学正弦波或 CSS @keyframes 实现不断扭曲的液化效果。

在最上层覆盖一个 <div>，赋予强烈的 backdrop-filter: blur(80px) 实现融合感。

5.4 播放器 UI 细节
CD 碟片拖拽控制： 监听 CD DOM 的 mousedown, mousemove (计算相对中心的 atan2 角度差)，将角度增量转换为时间增量，派发给大进度条和 audioEngine 实现快进/倒退。

进度条 Hover： 监听 mousemove 获取鼠标相对容器的 X 坐标，更新指示器竖线的位置，并弹出 Tooltip（显示“当前指向歌曲名 + 当前时间/总时间”）。


## 附录：推荐第三方工具库选型指南 (供 AI 开发参考)

**选型原则说明：**
用户的直觉非常准确：对于这样一个以**“重度动画、物理交互、时间轴编排”**为核心的项目，引入完整的 React/Vue 等重型声明式 UI 框架反而可能与底层动画库产生 DOM 控制权的冲突。因此，本项目的技术栈建议采用 **Vanilla JS (原生 JavaScript) + 专用微型库** 的组合。

以下是针对本项目各个技术难点推荐的工具库，AI 助手在编写具体模块时应优先考虑引入它们以大幅降低开发成本并提升运行性能：

### 1. 核心动画与时间轴编排
本项目存在极为复杂的转场动画（如：两侧专辑飞出 -> 视角俯视转换 -> CD 下落 -> 盖子闭合），纯靠原生 CSS `@keyframes` 难以精准控制时序。
* **首选库：GSAP (GreenSock Animation Platform)**
    * **适用场景：** 史诗级转场动画、Cover Flow 专辑墙视角的平滑切换。
    * **推荐理由：** 业界最顶级的 Web 动画引擎。它的 `gsap.timeline()` 可以像剪辑视频一样精确编排多个动画的先后顺序和交叠时间。完美解决复杂 DOM 元素的 3D Transform 时序同步问题。

### 2. 沉浸式色彩提取
* **首选库：Color Thief (或 Node-Vibrant / Vibrant.js)**
    * **适用场景：** 根据专辑封面动态生成流体背景色。
    * **推荐理由：** 只需传入图片的 Image 对象或 Canvas，即可瞬间提取出“主导色 (Dominant Color)”以及“调色板 (Palette)”。Vibrant.js 更是能直接提取出符合 UI 设计美学的“高亮色、暗调色”，极大地省去了手写 K-Means 像素聚类算法的麻烦。

### 3. 音频引擎与无缝播放 (Gapless Playback)
* **首选库：Howler.js (配合原生 Web Audio API)**
    * **适用场景：** MP3 解码、无缝切歌、全局音量控制。
    * **推荐理由：** 封装了复杂的 Web Audio API，提供极其简单的 `play()`, `seek()` 和跨浏览器兼容性。
    * **AI 开发注意：** 对于严格的**无缝拼接 (Gapless)**，Howler 本身可能有微小延迟。AI 在实现大进度条跨轨跳转时，需结合 Howler 的预加载逻辑，或直接回退调用底层 Web Audio API 的 `AudioContext` 进行 Buffer 节点的精确时间点拼接。

### 4. 复杂交互与物理拖拽
* **首选库：interact.js (或原生 Pointer Events)**
    * **适用场景：** 拖拽 CD 碟片顺时针/逆时针旋转以快进/快退、大进度条的精准拖动。
    * **推荐理由：** 提供极高帧率的物理拖拽、惯性滑动和角度计算支持。处理鼠标、触摸板、移动端 Touch 事件的统一兼容，避免手写大量繁杂的 `mousemove` / `touchmove` 监听器和三角函数 (atan2) 计算。

### 5. 轻量级状态同步 (替代 React/Vue)
虽然不使用大框架，但“播放时间更新 -> 进度条 UI 刷新”的频率极高，手动 `document.getElementById` 会导致代码难以维护。
* **首选库：Zustand (Vanilla 版本) 或 NanoStores**
    * **适用场景：** 记录当前播放状态、专辑列表数据，并在数据改变时自动触发 UI 更新。
    * **推荐理由：** 体积极小（<1KB），没有任何框架绑定。允许我们在 JavaScript 中建立一个集中的“数据仓库”，当音频时间更新时，只有订阅了该时间的进度条 DOM 会被更新，保持代码整洁且性能优异。