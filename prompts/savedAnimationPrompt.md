# 实现 Prompt：PlayerForSky 摄像机俯仰转场动画

## 项目背景

这是一个 CD 播放器 Web 应用，有两个视图：

- **主视图 (`#main-view`)**：Cover Flow 专辑选择界面，视觉隐喻是"平视墙上的唱片架"
- **播放视图 (`#playback-view`)**：CD 机播放界面，视觉隐喻是"俯视桌面上的 CD 机"

需要实现的转场动画：从主视图切换到播放视图时，模拟摄像机从平视向下旋转到俯视的过程。反向返回时做逆向动画。

## 你将修改的文件

1. **`index.html`** — 新增场景包装结构
2. **`css/layout.css`** 或新建 `css/camera.css` — 摄像机 3D 容器样式
3. **`css/animations.css`** — 更新/新增关键帧
4. **`js/views/viewManager.js`** — 重写转场逻辑（这是核心文件）

不要修改 `css/components.css` 中现有组件的样式定义。不要修改其他 JS 模块的公共接口。

## 架构设计

### HTML 结构变更

将两个 view 包入一个 3D 场景容器。注意 `#settings-backdrop` 和 `#settings-panel` 必须留在场景容器外部（它们不参与 3D 变换）：

```html
<body>
  <div class="camera-rig">
    <div class="scene">
      <div id="main-view" class="view">...</div>
      <div id="playback-view" class="view">...</div>
    </div>
  </div>

  <!-- 这些保留在 camera-rig 外面 -->
  <div id="settings-backdrop" class="settings-backdrop"></div>
  <div id="settings-panel" class="settings-panel">...</div>

  <script type="module" src="./js/main.js"></script>
</body>
```

### CSS 3D 场景基础

用 `CSS.registerProperty` 注册自定义属性使浏览器可以对其插值：

```js
CSS.registerProperty({ name: '--cam-rx', syntax: '<angle>', inherits: true, initialValue: '0deg' });
CSS.registerProperty({ name: '--cam-tz', syntax: '<length>', inherits: true, initialValue: '0px' });
```

```css
.camera-rig {
  perspective: 1200px;
  perspective-origin: center 50%;
  position: fixed;
  inset: 0;
  overflow: hidden;
}

.scene {
  transform-style: preserve-3d;
  transform-origin: center bottom;
  transform: rotateX(var(--cam-rx, 0deg)) translateZ(var(--cam-tz, 0px));
  width: 100%;
  height: 100%;
  position: relative;
}
```

### View 隐藏方式变更

**废弃 `display:none` 切换**。两个 view 始终保持在布局流中，用 `visibility` + `opacity` + `pointer-events` 控制可见性。将原有的 `.hidden` class 改为：

```css
.view { 
  position: absolute; inset: 0;
  transition: none; /* 转场期间由 JS 控制 */
}
.view.inactive {
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
}
```

在 `viewManager.js` 中，将所有 `classList.add('hidden')` / `classList.remove('hidden')` 替换为 `classList.add('inactive')` / `classList.remove('inactive')`。

## 动画分阶段设计

总时长约 1.4s。阶段之间有重叠来制造流畅感。

### 时间线总览

```
时间(ms)  0       300     550     750     900     1100    1400
          |──A────|       |       |       |       |       |
          |   |────────B(rotateX 0→90)────|       |       |
          |   |           |       |  swap |       |       |
          |   |           |       |───C(rotateX 90→0)────|
          |   |           |       |       |  |────D(CD)──|
```

### 阶段 A — 专辑展开（0ms – 300ms）

触发条件：用户点击中心专辑卡片。

执行内容：
1. 中心专辑卡片（`.album-card.center`）向左平移约 `albumSize * 0.6`，并 scale 到 0.92
2. 中心卡片的 `.cd-peek` 元素 opacity 0→1，translateX 偏移，模拟 CD 从封套抽出
3. 左侧相邻卡片继续向左飘出视野（可复用现有 `.fly-left`）
4. 右侧相邻卡片继续向右飘出视野（可复用现有 `.fly-right`）

使用 Web Animations API (WAAPI) 执行。缓动：`cubic-bezier(0.4, 0, 0.2, 1)`。

### 阶段 B — 摄像机下俯（150ms – 750ms）

与阶段 A 重叠 150ms 启动。

执行内容：在 `.scene` 元素上，通过 WAAPI 驱动 `--cam-rx` 从 `0deg` 到 `90deg`，同时 `--cam-tz` 从 `0px` 到 `350px`（dolly 补偿，防止画面因旋转变远而过度缩小）。

`transform-origin` 保持 `center bottom` 不变。

缓动：`cubic-bezier(0.45, 0, 0.15, 1)`（慢起慢收）。

**为什么旋转到 90deg**：在 rotateX=90deg 时，场景平面恰好变成一条线（edge-on），此刻肉眼不可见任何内容，是执行 view 切换的完美时机——不需要交叉淡入，不需要切换 transform-origin，零瑕疵。

### View 切换点（~750ms）

在阶段 B 的 WAAPI animation `onfinish` 回调中执行：

```js
mainView.classList.add('inactive');
playbackView.classList.remove('inactive');
```

此刻场景处于 rotateX(90deg)，用户看不到任何东西，切换完全不可见。

### 阶段 C — 摄像机回正（750ms – 1300ms）

紧跟在切换后立即启动。

执行内容：`.scene` 上 `--cam-rx` 从 `90deg` 回到 `0deg`，`--cam-tz` 从 `350px` 回到 `0px`。

缓动：`cubic-bezier(0.25, 0.8, 0.25, 1)`（快起慢收，给"着陆"感）。

播放视图从被压扁的状态逐渐展开为正常俯视画面。

### 阶段 D — CD 入场（950ms – 1400ms）

在阶段 C 进行到约 `--cam-rx` ≤ 45deg 时触发（可用 `requestAnimationFrame` 轮询当前角度，或简单地用 setTimeout 在阶段 C 启动后 200ms 触发）。

执行内容：
1. `#cd-disc` 从 `translateY(-150%) scale(0.8) opacity(0)` 动画到 `translateY(0) scale(1) opacity(1)`
2. 缓动带 overshoot：`cubic-bezier(0.34, 1.4, 0.64, 1)`，模拟 CD 落入卡槽的轻微弹跳
3. CD 动画完成后 200ms，`#cd-glass` 添加 `.closed` class（玻璃盖合上，已有 opacity transition）

时长 450ms。

## 反向转场：播放视图 → 主视图

总时长约 1.2s，是正向的镜像但适当简化：

1. **玻璃盖打开**（0–200ms）：移除 `#cd-glass` 的 `.closed` class
2. **CD 飞出**（100–400ms）：CD 向上 translateY(-150%) + opacity→0
3. **摄像机上仰**（300–800ms）：`--cam-rx` 0→90deg，`--cam-tz` 0→350px
4. **View 切换**（~800ms）：playbackView → inactive，mainView → active
5. **摄像机回正**（800–1200ms）：`--cam-rx` 90→0deg，`--cam-tz` 350→0px
6. **专辑卡片归位**（900–1200ms）：卡片从飞散位置动画回到 cover flow 布局位置

## 实现要求

### 必须使用 Web Animations API

所有动画用 `element.animate()` 或 CSS 自定义属性 + WAAPI 驱动。不使用 `setTimeout` 做时序控制（阶段串接用 `animation.finished` Promise）。示例模式：

```js
const phaseB = scene.animate(
  { '--cam-rx': ['0deg', '90deg'], '--cam-tz': ['0px', '350px'] },
  { duration: 600, easing: '...', fill: 'forwards' }
);

await phaseB.finished;
// swap views
const phaseC = scene.animate(
  { '--cam-rx': ['90deg', '0deg'], '--cam-tz': ['350px', '0px'] },
  { duration: 550, easing: '...', fill: 'forwards' }
);
```

阶段重叠通过 `delay` 参数或在前一阶段的特定时间点用 `phaseB.currentTime` 检查来触发下一阶段。

### CSS.registerProperty

在 `viewManager.js` 顶部或一个独立的 `initCamera.js` 中执行属性注册。加 try-catch 防止重复注册报错：

```js
try {
  CSS.registerProperty({ name: '--cam-rx', syntax: '<angle>', inherits: true, initialValue: '0deg' });
  CSS.registerProperty({ name: '--cam-tz', syntax: '<length>', inherits: true, initialValue: '0px' });
} catch(e) { /* already registered */ }
```

### 清理机制

每次转场完成后：
- 清除 `.scene` 上的 WAAPI animation（调用 `animation.cancel()` 或让 fill 模式自然结束后重置 CSS 变量）
- 确保 `--cam-rx` 和 `--cam-tz` 回到初始值
- 清除 CD 入场动画 class
- 清除飞散卡片的内联动画

### 防重入

在 `viewManager.js` 中维护一个 `let transitioning = false` 标志位。转场期间忽略新的转场请求。

### 性能

- 对 `.scene` 添加 `will-change: transform`（仅在转场期间，转场结束后移除）
- CD disc 入场动画只涉及 transform + opacity（GPU 合成层友好）
- 不要在动画帧中读取 layout 属性（避免强制回流）

### 导出接口

`viewManager.js` 导出的公共接口保持不变：

```js
export function showMain()
export function showPlayback()
export async function transitionToPlayback(onMidpoint)
export async function transitionToMain()
```

`onMidpoint` 回调在 view 切换点（rotateX=90deg）时调用，用于外部模块在切换瞬间同步状态（如加载播放数据）。

### 可调参数

在文件顶部用常量集中定义，便于调试：

```js
const CAM_DURATION_DOWN = 600;    // 阶段B时长
const CAM_DURATION_UP = 550;      // 阶段C时长
const CAM_MAX_ANGLE = '90deg';
const CAM_MAX_TZ = '350px';
const ALBUM_SPREAD_DURATION = 300; // 阶段A时长
const CD_ENTER_DURATION = 450;     // 阶段D时长
const CD_ENTER_DELAY = 200;        // 阶段D相对阶段C的延迟
```

## 不要做的事

- **不要引入 GSAP 或任何外部动画库**。纯 WAAPI + CSS。
- **不要修改 `components.css` 中已有的组件样式**（CD 机、专辑卡片等的静态样式保持不变）。
- **不要改变 settings panel 的行为或定位**。它在 camera-rig 外部，不受 3D 变换影响。
- **不要用 `setTimeout`/`setInterval` 做动画时序**。全部用 `animation.finished` Promise 链或 WAAPI 的 `delay` 参数。
- **不要产生新的 JS 文件**，所有逻辑放在 `viewManager.js` 中（CSS 注册逻辑可以在同一文件顶部）。