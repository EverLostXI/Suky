# 最终实现 Prompt：PlayerForSky 3D 摄像机俯仰转场动画

## 一、项目概述与目标

这是一个 CD 播放器 Web 应用。有两个视图：主视图（Cover Flow 专辑选择）和播放视图（CD 机播放界面）。

**目标**：实现一个3D摄像机动画转场。场景中有两个垂直的平面——"墙面"（挂着专辑封面）和"桌面"（放着CD机），它们呈 L 型 90° 关系。用户在初始状态就能同时看到这两个平面（墙面正对，桌面以透视梯形出现在画面底部）。进入播放时，摄像机从平视墙面旋转到俯视桌面。

**核心原则**：所有3D旋转动画在主界面完成。当桌面CD机完全正对摄像机时（此刻画面和播放页一模一样），悄悄切换到播放页，然后播放页只负责执行简单的2D"CD从上方落入碟仓"动画。

---

## 二、3D 几何模型详解

从侧面看这个场景的空间关系：

```
侧视图（从左向右看）：

   眼睛 (perspective point)
     │
     │ 视线
     ▼
   ┌─────────┐   ← wall-plane
   │  专辑墙  │      面朝摄像机（rotateX: 0）
   │ CoverFlow│      position: absolute; inset: 0
   │          │
   └────┬─────┘   ← wall-plane 底边 = table-plane 顶边（铰接点）
        │
   ═════╧══════   ← table-plane
     CD机桌面        rotateX(-90deg), transform-origin: top center
                     它从 wall-plane 底边向"屏幕里面"躺平
```

**为什么这样就能工作**：

- 初始 `--cam-rx: 0deg`：摄像机水平看。wall-plane 完全正面朝向你（cos(0)=1，满宽满高）。table-plane 因为自身 rotateX(-90deg)，对摄像机来说是几乎完全侧面的——但因为 perspective 存在，你会看到一个扁扁的梯形出现在画面底部。这就是用户一开始就能"余光看到桌上CD机"的效果。

- `--cam-rx: 45deg`：摄像机低头一半。wall-plane 有效角度变成 45deg（被压扁到 cos(45°)≈70% 高度），table-plane 有效角度变成 -90+45=-45deg（也是斜着的，但已经明显可见了）。

- `--cam-rx: 80deg`：摄像机几乎完全俯视。wall-plane 有效角度 80deg（几乎侧面消失，cos(80°)≈17%，只剩一条线）。table-plane 有效角度 -90+80=-10deg（几乎完全正对你）。此刻桌面CD机的样子就是播放页的样子。

---

## 三、HTML 结构变更

### 3.1 新增 3D 场景包装器

在 `index.html` 中，用新的 3D 容器包裹 `#main-view` 和 `#playback-view`。settings 面板留在外面。

**变更前**的简化结构：
```html
<body>
  <div id="main-view" class="view">...</div>
  <div id="playback-view" class="view hidden">...</div>
  <div id="settings-backdrop">...</div>
  <div id="settings-panel">...</div>
</body>
```

**变更后**：
```html
<body>
  <!-- 3D 摄像机容器 -->
  <div class="camera-rig">
    <div class="scene-3d">

      <!-- 墙面：原 main-view 的全部内容 -->
      <div class="wall-plane">
        <div id="main-view" class="view">
          <!-- 保持原有内容完全不变：top-bar, search-overlay,
               cover-flow-stage, album-info, cd-player-preview -->
        </div>
      </div>

      <!-- 桌面：静态CD机副本 -->
      <div class="table-plane">
        <div class="table-cd-machine">
          <div class="table-cd-body"></div>
          <div class="table-cd-well"></div>
          <!-- 没有CD碟片在里面 —— CD入场动画在播放页做 -->
        </div>
      </div>

    </div><!-- /.scene-3d -->
  </div><!-- /.camera-rig -->

  <!-- 播放视图：不在 3D 场景内，固定覆盖全屏 -->
  <div id="playback-view" class="view inactive">
    <!-- 保持原有内容完全不变 -->
  </div>

  <!-- 设置面板：不在 3D 场景内 -->
  <div id="settings-backdrop" class="settings-backdrop"></div>
  <div id="settings-panel" class="settings-panel">...</div>

  <!-- 全局顶栏也留在外面（它 position:fixed，不受3D影响） -->
  <div class="global-top-bar">...</div>

  <script type="module" src="./js/main.js"></script>
</body>
```

**关键点**：
- `#playback-view` **不在** `.scene-3d` 里面。它是独立的全屏固定层。3D旋转只影响 `.scene-3d` 内部的墙面和桌面。
- `#main-view` 被嵌入 `.wall-plane` 内部，但它自身的所有样式和内容不变。
- 原来 `#main-view` 里的 `#cd-player-preview`（底部 hover 时出现的 CD 机预览）可以**移除**，因为桌面的 `.table-plane` 已经取代了它的功能。

### 3.2 table-plane 内部的静态CD机

这是一个视觉等价但 DOM 极简的副本，只需要"看起来像播放页的CD机"。不需要任何交互。

```html
<div class="table-plane">
  <div class="table-cd-machine">
    <!-- 木质+深灰底座，对应播放页 .cd-machine-body -->
    <div class="table-cd-body"></div>
    <!-- 中央碟仓凹陷区域 -->
    <div class="table-cd-well"></div>
  </div>
</div>
```

样式需要让它在俯视正对时（`--cam-rx: ~80deg`）看起来和播放页的 `.cd-machine` 完全一致。详见 CSS 部分。

### 3.3 cd-peek 样式升级

当前 `.cd-peek` 使用的是简单的 `radial-gradient` 碟片。需要升级为和播放页 `.cd-disc` 一致的样式，包括虹彩光环（`conic-gradient`）和中心 label 区域（显示专辑封面缩略图）。

**做法**：将 `.cd-peek` 的内部结构改为和 `.cd-disc` 共享同一套 CSS class。具体来说，在 `.cd-peek` 内部嵌套一个使用 `.cd-disc` 样式的缩小版元素：

```html
<!-- 在 album-card 的 center 卡片里 -->
<div class="cd-peek">
  <div class="cd-peek-disc">
    <div class="cd-peek-label">
      <img src="封面url" alt="" />
    </div>
  </div>
</div>
```

`.cd-peek-disc` 和 `.cd-peek-label` 的样式从 `.cd-disc` 和 `.cd-label` 派生，只是尺寸缩小到 `calc(var(--album-size) * 0.9)` 并且是绝对定位在专辑封面右侧。保留虹彩 `conic-gradient` 的 `::before`，保留中心封面图。省略 `::after`（spindle hole，太小看不见）。

> **注意**：这个升级需要修改 `components.js` 中 `_buildCard()` 函数，在创建 center 卡片的 cd-peek 时构建新的 DOM 结构，并设置 img.src 为当前专辑的 cover_url。

---

## 四、CSS 变更详解

### 4.1 CSS 自定义属性注册

在 `viewManager.js` 顶部注册，使浏览器能对自定义属性做插值：

```js
try {
  CSS.registerProperty({ name: '--cam-rx', syntax: '<angle>', inherits: true, initialValue: '0deg' });
  CSS.registerProperty({ name: '--cam-tz', syntax: '<length>', inherits: true, initialValue: '0px' });
} catch(e) { /* 已经注册过，忽略 */ }
```

### 4.2 camera-rig 和 scene-3d

```css
.camera-rig {
  position: fixed;
  inset: 0;
  perspective: 900px;
  perspective-origin: center 50%;
  overflow: hidden;
  z-index: 1; /* 低于 settings panel */
}

.scene-3d {
  position: relative;
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;
  transform-origin: center center;
  transform: rotateX(var(--cam-rx, 0deg));
}
```

**解释**：
- `perspective: 900px` 控制透视强度。值越小越夸张，越大越平。900px 是视觉戏剧感和变形控制之间的平衡点。
- `perspective-origin: center 50%` 表示透视消失点在画面正中。
- `transform-origin: center center` 表示摄像机绕视野中心旋转。如果想让初始状态下桌面更可见，可以把 origin 设成 `center 60%`（偏下），这样旋转时上半部分移动幅度更大。需要实际测试调整。
- `.scene-3d` 使用 `preserve-3d` 确保子元素（wall-plane, table-plane）各自保留自己的3D位置。

### 4.3 wall-plane

```css
.wall-plane {
  position: absolute;
  inset: 0;
  /* 不加任何 transform，它就自然面朝摄像机 */
  /* 但需要 preserve-3d 让内部的 cover-flow 3D 效果正常工作 */
  transform-style: preserve-3d;
}
```

**关键注意**：`#main-view` 现在在 `.wall-plane` 内部。`#main-view` 原来是 `position: fixed; inset: 0`。现在它的定位上下文变成了 `.wall-plane`。由于 `.wall-plane` 也是 `position: absolute; inset: 0` 且在一个 `position: fixed` 的 `.camera-rig` 内部，所以 `#main-view` 的 `fixed` 定位仍然相对于 viewport 工作。但为了安全，建议把 `#main-view` 改为 `position: absolute; inset: 0`（因为在 `preserve-3d` 容器内部，fixed 定位可能表现异常）。

```css
#main-view {
  position: absolute;  /* 从 fixed 改为 absolute */
  inset: 0;
  /* 其余保持不变 */
}
```

同理，`#main-view` 内部使用 `position: fixed` 的子元素（如 `.search-overlay`、`.cd-player-preview`）在 `preserve-3d` 容器内可能会脱离3D上下文。**解决方案**：搜索 overlay 和其他 fixed 定位元素也需要改为 `absolute`，或者把它们移到 `.camera-rig` 外面（与 settings panel 同级）。这需要逐个检查。最简单的做法是：

- `.search-overlay`：移到 `.camera-rig` 外部（它是全屏覆盖的UI层，不应该参与3D变换）
- `.global-top-bar`：已经在外部了
- 原有的 `.cd-player-preview`：**删除**，被 `.table-plane` 取代

### 4.4 table-plane

```css
.table-plane {
  position: absolute;
  /* 定位在 wall-plane 底边 */
  bottom: 0;
  left: 50%;
  transform: translateX(-50%) rotateX(-90deg);
  transform-origin: top center;
  /* 尺寸需要调到让CD机正对时和播放页视觉匹配 */
  width: 600px;
  height: 600px;
  /* 允许内部元素溢出（CD机的阴影等） */
  overflow: visible;
  pointer-events: none; /* 静态展示，不接受交互 */
}
```

**解释**：
- `bottom: 0` + `transform-origin: top center` + `rotateX(-90deg)` = 面板从 wall-plane 的底边向"屏幕里面"翻倒 90°，形成 L 型的桌面。
- `translateX(-50%)` + `left: 50%` = 水平居中。
- 当 `--cam-rx` 增大到 80deg 时，table-plane 的实际可见角度 = -90 + 80 = -10deg，几乎正对。

### 4.5 table-plane 内部的静态CD机样式

```css
.table-cd-machine {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 340px;
  height: 340px;
  /* 和播放页 .cd-machine 的 scale 保持一致 */
  /* 播放页用了 transform: scale(1.28) translateY(-45px)
     但这里不需要 translateY 偏移（因为俯视时垂直偏移没有意义），
     只需要 scale 匹配 */
}

.table-cd-body {
  /* 复制播放页 .cd-machine-body 的样式 */
  position: absolute;
  inset: -40px;
  background: #2a2a2a;
  border: 24px solid #2b1408;
  border-radius: 32px;
  box-shadow:
    0 20px 80px rgba(0,0,0,0.8),
    inset 0 4px 20px rgba(0,0,0,0.8);
}

.table-cd-well {
  /* 中央碟仓区域 —— 一个圆形凹陷 */
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 300px;
  height: 300px;
  border-radius: 50%;
  background: radial-gradient(circle, #1a1a1a 0%, #111 50%, #0d0d0d 100%);
  box-shadow: inset 0 0 20px rgba(0,0,0,0.8);
}
```

**尺寸匹配的关键**：播放页的 CD 机用了 `scale(1.28)`，所以实际视觉尺寸是 `340 * 1.28 = 435px`。table-plane 的 CD 机需要在正对时匹配这个视觉尺寸。由于 table-plane 自身可能还受到 perspective 的轻微缩放，精确匹配需要实际测试微调。**建议做法**：先用上述数值实现，然后在 `--cam-rx: 80deg` 时截图和播放页对比，通过调整 `.table-cd-machine` 的 scale 来对齐。

### 4.6 View 隐藏方式变更

**废弃 `.hidden` class**（`display:none` 语义），改用 `.inactive`：

```css
/* 原来的：删除或保留兼容但不再用于view切换 */
.view.hidden {
  opacity: 0;
  pointer-events: none;
}

/* 新增：用于 playback-view 的隐藏 */
.view.inactive {
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
}
```

**注意**：`#main-view` 不再使用 `.hidden` 或 `.inactive`。它始终可见（在 wall-plane 内部），只是随着摄像机旋转自然消失在视野中。`#playback-view` 在转场前使用 `.inactive` 隐藏，在切换点移除 `.inactive` 使其可见。

### 4.7 cd-peek 升级样式

```css
/* cd-peek 容器保持原有定位逻辑 */
.album-card .cd-peek {
  position: absolute;
  top: 50%;
  right: -10px;
  transform: translateY(-50%) translateX(0);
  width: calc(var(--album-size) * 0.9);
  height: calc(var(--album-size) * 0.9);
  opacity: 0;
  transition: opacity var(--t-normal), transform var(--t-normal);
  z-index: 1;
  pointer-events: none;
}

/* 内部碟片使用和 .cd-disc 一致的视觉 */
.cd-peek-disc {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 50%,
    #3a3a3a 0%, #222 20%, #1a1a1a 35%, #0d0d0d 50%,
    #181818 65%, #242424 80%, #1c1c1c 100%);
  box-shadow:
    0 0 0 2px #2a2a2a,
    0 10px 30px rgba(0,0,0,0.8),
    inset 0 0 30px rgba(255,255,255,0.03);
  position: relative;
}

/* 虹彩光环 —— 和 .cd-disc::before 一致 */
.cd-peek-disc::before {
  content: '';
  position: absolute;
  inset: 8px;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    rgba(255,200,150,0.08), rgba(150,200,255,0.1),
    rgba(200,150,255,0.08), rgba(150,255,200,0.08),
    rgba(255,200,150,0.08)
  );
}

/* 中心封面区域 —— 和 .cd-label 一致 */
.cd-peek-label {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 75%;
  height: 75%;
  border-radius: 50%;
  overflow: hidden;
  box-shadow: 0 0 0 4px #111;
  z-index: 3;
}
.cd-peek-label img {
  width: 100%; height: 100%;
  object-fit: cover;
}
```

---

## 五、JS 实现详解 —— viewManager.js 重写

### 5.1 文件顶部：注册属性 + 获取 DOM 引用 + 常量

```js
/**
 * viewManager.js — 3D 摄像机转场系统
 */
import state from '../core/state.js';

// ── 注册 CSS 自定义属性（必须在 animate() 之前）──
try {
  CSS.registerProperty({ name: '--cam-rx', syntax: '<angle>', inherits: true, initialValue: '0deg' });
} catch(e) {}

// ── DOM 引用 ──
const scene       = document.querySelector('.scene-3d');
const wallPlane   = document.querySelector('.wall-plane');
const tablePlane  = document.querySelector('.table-plane');
const mainView    = document.getElementById('main-view');
const playbackView= document.getElementById('playback-view');

// ── 可调参数 ──
const CAM_TARGET_ANGLE  = 70;          // 摄像机最终俯角（deg）
const PHASE_A_DURATION  = 400;         // 阶段A：碟片滑出+封面展开
const PHASE_B_DURATION  = 700;         // 阶段B：摄像机下俯
const PHASE_B_DELAY     = 250;         // 阶段B相对阶段A的延迟启动
const VIEW_SWITCH_DELAY = 50;          // 到达目标角度后等多久切换view
const PHASE_D_DELAY     = 200;         // 阶段D(CD落入)相对view切换的延迟
const CD_DROP_DURATION  = 500;         // CD落入动画时长

const CAM_EASE_DOWN = 'cubic-bezier(0.45, 0, 0.15, 1)';  // 慢起慢收
const CAM_EASE_UP   = 'cubic-bezier(0.25, 0.8, 0.25, 1)'; // 快起慢收

// ── 防重入 ──
let transitioning = false;
```

### 5.2 showMain / showPlayback 基础函数

```js
export function showMain() {
  document.body.classList.remove('in-playback');
  playbackView.classList.add('inactive');
  // main-view 始终可见（在 wall-plane 内），不需要 class 切换
  state.set('view', 'main');
}

export function showPlayback() {
  document.body.classList.add('in-playback');
  playbackView.classList.remove('inactive');
  state.set('view', 'playback');
}
```

### 5.3 正向转场：transitionToPlayback

这是最核心的函数。分4个阶段：

```js
/**
 * 转场：主界面 → 播放界面
 *
 * 阶段A (0ms~400ms)：碟片从封套滑出 + 两侧专辑飞散 + 中心专辑淡出
 *   - 由 components.js 中的 enterPlayback() 在调用本函数之前已经执行
 *   - 本函数被调用时，卡片飞散动画已在进行中
 *
 * 阶段B (250ms~950ms)：摄像机下俯
 *   - scene-3d 的 --cam-rx 从 0deg 旋转到 80deg
 *   - 墙面内容随透视被压扁消失
 *   - 桌面CD机从底部梯形逐渐变为正对
 *
 * 切换点 (~1000ms)：view 切换
 *   - 此刻桌面CD机已完全正对，和播放页一模一样
 *   - 隐藏 camera-rig（或将 --cam-rx 保持），显示 playback-view
 *
 * 阶段D (~1200ms~1700ms)：CD从上方落入碟仓
 *   - 纯2D动画，在 playback-view 中执行
 */
export async function transitionToPlayback(onMidpoint) {
  if (transitioning) return;
  transitioning = true;

  // 性能提示
  scene.style.willChange = 'transform';

  // 阶段B：摄像机下俯（与阶段A的卡片飞散重叠进行）
  // components.js 中 enterPlayback() 在调用本函数前已经启动了卡片飞散，
  // 所以这里直接开始摄像机旋转，中间有 PHASE_B_DELAY 的延迟让飞散先行。
  await delay(PHASE_B_DELAY);

  const camDown = scene.animate(
    [
      { '--cam-rx': '0deg' },
      { '--cam-rx': `${CAM_TARGET_ANGLE}deg` }
    ],
    {
      duration: PHASE_B_DURATION,
      easing: CAM_EASE_DOWN,
      fill: 'forwards'   // 保持最终角度，直到我们手动重置
    }
  );

  await camDown.finished;

  // 切换点：此刻桌面正对摄像机，和播放页画面一致
  await delay(VIEW_SWITCH_DELAY);
  onMidpoint?.();            // 外部回调：加载音频、设置进度条、设置封面等
  showPlayback();            // playback-view 显示
  
  // 隐藏 camera-rig 内容（桌面CD机副本）避免和播放页重叠
  scene.style.visibility = 'hidden';

  // 重置摄像机角度（为下次转场做准备）
  camDown.cancel();
  scene.style.setProperty('--cam-rx', '0deg');
  scene.style.willChange = '';

  // 阶段D：CD落入碟仓
  await delay(PHASE_D_DELAY);

  const cdDisc = document.getElementById('cd-disc');
  const cdDropAnim = cdDisc.animate(
    [
      { transform: 'translateY(-120vh) rotate(0deg)', opacity: 0 },
      { transform: 'translateY(0) rotate(0deg)',      opacity: 1 }
    ],
    {
      duration: CD_DROP_DURATION,
      easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)',  // overshoot，模拟落入弹跳
      fill: 'forwards'
    }
  );

  await cdDropAnim.finished;
  cdDropAnim.cancel();
  cdDisc.style.transform = '';  // 清理，让 RAF 旋转循环接管

  // 恢复 camera-rig 可见性（为返回做准备）
  scene.style.visibility = '';

  transitioning = false;
}
```

**关键逻辑解释**：

1. `fill: 'forwards'` 让 WAAPI 动画结束后保持最终值。但我们在 view 切换后立刻 `cancel()` 并手动重置 `--cam-rx`，因为我们不想让一个悬挂的 animation fill 和后续操作冲突。

2. `scene.style.visibility = 'hidden'` 在 view 切换时隐藏整个3D场景。这很重要——否则桌面CD机副本会和播放页真正的CD机重叠。等返回转场前再恢复。

3. CD 落入动画用 WAAPI 的 `element.animate()`。注意 `translateY(-120vh)` 是从视口上方很远处落下。easing 带 overshoot（贝塞尔曲线的第4个值 > 1）模拟弹性。

4. CD 落入动画结束后 `cancel()` + 清空 `style.transform`，让 `components.js` 中的 RAF 旋转循环（`_cdLoop`）无缝接管 transform。

### 5.4 反向转场：transitionToMain

```js
/**
 * 转场：播放界面 → 主界面
 *
 * 阶段1：CD从碟仓飞出（向上）
 * 阶段2：切换回主界面（此时摄像机处于俯视角度，显示桌面CD机）
 * 阶段3：摄像机上仰回到平视
 * 阶段4：专辑卡片归位 + 碟片滑回封套
 */
export async function transitionToMain() {
  if (transitioning) return;
  transitioning = true;

  // 阶段1：CD飞出
  const cdDisc = document.getElementById('cd-disc');
  const cdFlyOut = cdDisc.animate(
    [
      { transform: 'translateY(0)',      opacity: 1 },
      { transform: 'translateY(-120vh)', opacity: 0 }
    ],
    {
      duration: 400,
      easing: 'cubic-bezier(0.4, 0, 1, 1)',  // ease-in，加速飞走
      fill: 'forwards'
    }
  );
  await cdFlyOut.finished;
  cdFlyOut.cancel();

  // 阶段2：切换到主界面（摄像机先设到俯视角度，显示桌面）
  scene.style.setProperty('--cam-rx', `${CAM_TARGET_ANGLE}deg`);
  scene.style.willChange = 'transform';
  // scene 重新可见
  scene.style.visibility = '';

  // 隐藏播放页
  playbackView.classList.add('inactive');
  document.body.classList.remove('in-playback');
  state.set('view', 'main');

  await delay(50); // 让浏览器提交状态

  // 阶段3：摄像机上仰回到平视
  const camUp = scene.animate(
    [
      { '--cam-rx': `${CAM_TARGET_ANGLE}deg` },
      { '--cam-rx': '0deg' }
    ],
    {
      duration: 800,
      easing: CAM_EASE_UP,
      fill: 'forwards'
    }
  );

  // 阶段4 与阶段3 重叠：在摄像机开始上仰约 400ms 后，触发卡片归位
  // 这个回调由 components.js 提供，在外部处理
  // 本函数返回一个 Promise，在摄像机上仰完成后 resolve
  await camUp.finished;
  camUp.cancel();
  scene.style.setProperty('--cam-rx', '0deg');
  scene.style.willChange = '';

  transitioning = false;
}
```

**重要的接口变更**：`transitionToMain()` 不再在内部处理 cover flow 重建。它只负责3D摄像机动画和 view 切换。cover flow 重建由 `components.js` 中的 `backBtn` click handler 在 `transitionToMain()` resolve 后调用 `renderCoverFlow(false)`。

现有的 `components.js` 中 `backBtn` handler 是：
```js
backBtn.addEventListener('click', async () => {
  // ... 停止播放等 ...
  await transitionToMain();
  renderCoverFlow(false);  // 这行已经存在，不需要改
});
```

### 5.5 delay 工具函数

```js
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
```

---

## 六、components.js 变更

### 6.1 cd-peek DOM 构建

在 `_buildCard()` 函数中，创建 center 卡片的 cd-peek 部分需要改成新结构：

```js
// 原来的代码（简单 div）：
if (relPos === 0) {
  const peek = document.createElement('div');
  peek.className = 'cd-peek';
  card.appendChild(peek);
}

// 改为：
if (relPos === 0) {
  const peek = document.createElement('div');
  peek.className = 'cd-peek';

  const disc = document.createElement('div');
  disc.className = 'cd-peek-disc';

  const label = document.createElement('div');
  label.className = 'cd-peek-label';

  if (album.cover_url) {
    const img = document.createElement('img');
    img.src = album.cover_url;
    img.alt = '';
    img.draggable = false;
    label.appendChild(img);
  }

  disc.appendChild(label);
  peek.appendChild(disc);
  card.appendChild(peek);
}
```

同样的修改需要应用到 `_positionCard()` 中创建 cd-peek 的地方。

### 6.2 enterPlayback 中的卡片飞散

现有逻辑基本不变，但碟片（cd-peek）在飞散阶段应该 fade out：

```js
// 在 enterPlayback 的卡片飞散循环中，对 center 卡片：
} else {
  // Center album: 先让碟片缩回，然后整体淡出
  const peek = card.querySelector('.cd-peek');
  if (peek) {
    peek.style.transition = 'opacity 0.2s ease';
    peek.style.opacity = '0';
  }
  card.style.transition = 'transform 0.55s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease 0.22s';
  card.style.transform  = `translateX(0) rotateY(0deg) translateZ(500px) scale(2.5)`;
  card.style.opacity    = '0';
}
```

### 6.3 删除 cd-player-preview

`#cd-player-preview` 相关的 DOM 和 JS 代码可以全部删除（包括 hover zone 中控制它显隐的逻辑），因为 `.table-plane` 完全取代了它。

### 6.4 enterPlayback 中调用 transitionToPlayback 的时机

现有代码在卡片飞散动画启动后 `await delay(500)` 然后调用 `transitionToPlayback()`。新方案中，`transitionToPlayback()` 内部自带 `PHASE_B_DELAY` 来协调和卡片飞散的重叠，所以外部的 `delay(500)` 应该**缩短或移除**：

```js
// 在 enterPlayback() 中：

// 1. 启动卡片飞散（不 await，让它们自己飞）
// ... 现有的卡片飞散代码 ...

// 2. 加载专辑详情（和飞散并行）
const albumDetailPromise = loadAlbumDetail(albumSummary.detail_url);

// 3. 不再等待 500ms，直接进入转场
//    transitionToPlayback 内部会处理时序
const albumDetail = await albumDetailPromise;
state.set('currentAlbum', albumDetail);

await transitionToPlayback(async () => {
  audioEngine.loadAlbum(albumDetail);
  setupProgressBar(albumDetail);
  updateCdCover(albumDetail.cover_url);
  setupDynamicBackground(albumDetail.cover_url);
});
```

---

## 七、动画时间线总览

```
时间      0     200    400    600    800    1000   1200   1500   1800
          |      |      |      |      |      |      |      |      |
卡片飞散  |████████████████|
碟片淡出  |██████|
摄像机俯  |  delay |████████████████████████|
                 250ms        700ms
view切换                                     |██|
场景隐藏                                       |██
CD落入                                            |██████████████|
                                              delay    500ms
                                              200ms
```

反向：
```
时间      0     200    400    600    800    1000   1200   1500
          |      |      |      |      |      |      |      |
CD飞出    |██████████████|
view切换                 |██|
场景显示                   |██
摄像机仰                     |██████████████████████████████|
                                    800ms
卡片归位                                          |██████████████|
```

---

## 八、需要特别注意的陷阱

### 8.1 preserve-3d 和 fixed 定位的冲突

**CSS 规范规定**：在设置了 `transform-style: preserve-3d` 的元素内部，`position: fixed` 的子元素会被当作 `position: absolute` 处理（因为 3D 变换创建了新的 containing block）。

受影响的元素：
- `#main-view`（已建议改为 absolute）
- `.search-overlay`（position: fixed → 需要移到 camera-rig 外部）
- `.progress-container`（在 playback-view 中，不受影响，因为 playback-view 不在 scene-3d 内部）

**处理方案**：将 `.search-overlay` 从 `#main-view` 内部移到 `<body>` 直接子级（与 settings-panel 同级）。JS 中控制它显隐的逻辑不变（仍然监听 main-view 的 mousemove），只是 DOM 位置变了。

### 8.2 cover-flow 的嵌套 perspective

`.cover-flow-stage` 上有 `perspective: 1000px`，`.cover-flow` 上有 `perspective: 1200px`。这些在 wall-plane 内部形成嵌套的 perspective 上下文。这不会破坏外层的 3D 变换——内层 perspective 只影响 cover-flow 卡片之间的 3D 效果（rotateY, translateZ），外层 perspective 影响 wall-plane 整体如何被摄像机看到。但需确保 `.cover-flow-stage` 没有设置 `transform-style: flat`（检查：当前没有，OK）。

### 8.3 WAAPI 对 CSS 自定义属性的支持

`element.animate()` 驱动 CSS 自定义属性需要通过 `CSS.registerProperty()` 注册类型。**只有注册了 `<angle>` 语法的 `--cam-rx` 才能被浏览器插值**。如果注册失败（极老的浏览器），动画会直接跳到终值。作为 fallback，可以检测注册是否成功，失败时改用 `requestAnimationFrame` 手动插值：

```js
let useWaapi = true;
try {
  CSS.registerProperty({ name: '--cam-rx', syntax: '<angle>', inherits: true, initialValue: '0deg' });
} catch(e) {
  if (e.name === 'InvalidModificationError') {
    // 已注册，没问题
  } else {
    useWaapi = false; // 浏览器不支持 registerProperty
  }
}
```

如果 `useWaapi === false`，转场函数需要降级为 RAF 循环手动设置 `--cam-rx`。但现代 Chrome/Edge/Safari/Firefox 都支持 `CSS.registerProperty`，所以这是一个极端 edge case。

### 8.4 table-plane 尺寸和对齐的微调

table-plane 的 CD 机在 `--cam-rx: 80deg` 时需要和播放页的 CD 机画面像素级匹配（至少近似匹配）。由于涉及 perspective 缩放、元素尺寸、嵌套偏移，最终数值无法纯计算得到，需要**肉眼对比调参**。

**调试方法**：
1. 临时把 `--cam-rx` 固定为 `80deg`（在 devtools 中修改 `.scene-3d` 的 CSS 变量）
2. 截图
3. 对比播放页截图
4. 调整 `.table-cd-machine` 的 width/height/scale 直到匹配

### 8.5 背景处理

播放页有动态背景（`#global-bg` + canvas），由 `body.in-playback` 控制显隐。在摄像机旋转期间，墙面内容逐渐消失，背景也会透过来。需要确保摄像机旋转期间背景的过渡是自然的。

当前 `#global-bg` 的 `transition: opacity 0.8s ease` 已经足够平滑。在 `enterPlayback()` 开始时 `document.body.classList.add('in-playback')` 就会触发背景渐显，这和摄像机旋转同步进行。

---

## 九、不要做的事

- **不要引入 GSAP 或任何外部动画库**。纯 WAAPI + CSS。
- **不要修改 `css/variables.css`**。
- **不要改变 settings panel 的行为或定位**。
- **不要修改 `audioEngine.js`、`dataLoader.js`、`colorExtractor.js`、`state.js`**。
- **不要改变 playback-view 内部的 DOM 结构或样式**（CD机、进度条、控制按钮等保持原样）。
- **不要用 `setTimeout`/`setInterval` 做动画时序**。所有动画用 WAAPI 的 `animation.finished` Promise 串接。仅在需要短暂等待浏览器提交渲染时使用 `delay(16-50)`。
- **不要产生新的 JS 文件**。所有视图管理逻辑在 `viewManager.js` 中，CD-peek DOM 构建修改在 `components.js` 中。CSS 变更可以放在现有文件中或新建 `css/camera.css`（如果新建，需要在 `index.html` 中 link）。

---

## 十、文件变更清单

| 文件 | 变更类型 | 内容 |
|------|---------|------|
| `index.html` | **改** | 增加 camera-rig/scene-3d/wall-plane/table-plane 包装结构；移动 search-overlay 到 body 直接子级；删除 cd-player-preview |
| `css/layout.css` | **改** | #main-view 改为 position:absolute；新增 .camera-rig、.scene-3d、.wall-plane、.table-plane、.table-cd-machine 样式；新增 .view.inactive 样式 |
| `css/components.css` | **改** | 新增 .cd-peek-disc、.cd-peek-label 样式；删除 .cd-player-preview 相关样式 |
| `css/animations.css` | **改** | 删除 .playback-entering-anim 相关的 machineEmerge/cdSmoothDrop 动画（被新的 WAAPI CD 落入动画取代） |
| `js/views/viewManager.js` | **重写** | 全部替换为本文档第五节的内容 |
| `js/views/components.js` | **改** | _buildCard() 的 cd-peek 构建改为新结构；enterPlayback() 调整时序；删除 cd-player-preview 相关逻辑 |