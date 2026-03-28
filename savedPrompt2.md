这是个很有意思的动画设计。我仔细想了一下，核心难点在于用 DOM 的 `perspective` + `rotateX` 模拟"摄像机俯仰"，同时还要在动画中途做 view 切换而不穿帮。下面是我的分析。

---

## 核心思路：3D 场景容器 + CSS Custom Property 驱动旋转

不用 canvas，最接近"摄像机旋转"的方式是给一个场景包装器施加 `perspective` + `rotateX`，让所有子元素跟着一起产生透视形变。

```html
<div class="camera-rig">        <!-- perspective 挂在这里 -->
  <div class="scene">            <!-- rotateX 挂在这里，JS 驱动 -->
    <div id="main-view">...</div>
    <div id="playback-view">...</div>
  </div>
</div>
```

```css
.camera-rig {
  perspective: 1200px;
  perspective-origin: center 45%;   /* 略偏下，模拟人眼位置 */
  overflow: hidden;
  position: fixed; inset: 0;
}

.scene {
  transform-style: preserve-3d;
  transform-origin: center bottom;  /* 绕底边旋转 = 向下看 */
  transform: rotateX(var(--cam-rx, 0deg))
             translateZ(var(--cam-tz, 0px));
  width: 100%; height: 100%;
}
```

JS 用 `requestAnimationFrame` 或 Web Animations API 平滑地把 `--cam-rx` 从 `0deg` 推到约 `72–78deg`，配合 `--cam-tz` 做 dolly 补偿（旋转时画面会"远离"观众，需要 translateZ 前推来补偿缩小）。

---

## 动画分阶段设计

我建议分 **4 个阶段**，总时长约 1.2–1.6s：

### 阶段 A — 专辑展开（0 – 300ms）

**做什么**：中心专辑卡片向左平移，露出后面的 `.cd-peek`；左右相邻专辑继续向两侧漂开。

**实现**：纯 CSS class 切换或 WAAPI。这一步还不需要动摄像机。

```js
centerCard.animate([
  { transform: currentTransform },
  { transform: `translateX(-${albumSize * 0.6}px) scale(0.92)` }
], { duration: 300, easing: 'cubic-bezier(0.4,0,0.2,1)', fill: 'forwards' });
```

`.cd-peek` 同步 opacity 0→1 + translateX 偏移，模拟 CD 从封套里抽出。

### 阶段 B — 摄像机下俯（200ms – 900ms）

> 与阶段 A 有 100ms 重叠，让"唱片抽出"和"低头看"衔接自然。

**做什么**：`--cam-rx` 从 `0deg` → `~75deg`，`--cam-tz` 同步从 `0` → `~300px`。主视图内容随着透视形变产生"远去"感。

**关键细节**：
- `transform-origin: center bottom` 意味着画面底边不动、顶部向远处倒——符合"低头看桌面"的直觉。
- 在 `~55–65deg` 的时候画面已经极度压缩，这就是 view 切换的最佳时机。
- 用一条 **ease-in-out** 缓动，保证起步和收尾都柔和。

```js
// 简化示例：用 WAAPI 驱动 CSS 变量
document.querySelector('.scene').animate([
  { '--cam-rx': '0deg',  '--cam-tz': '0px'   },
  { '--cam-rx': '75deg', '--cam-tz': '300px'  }
], {
  duration: 700,
  easing: 'cubic-bezier(0.45, 0, 0.15, 1)',
  fill: 'forwards',
  // ⚠️ 注意：WAAPI 驱动 CSS 自定义属性需要
  // 用 CSS.registerProperty 注册为 <angle>/<length>
});
```

需要注册自定义属性才能让浏览器对其插值：

```js
CSS.registerProperty({
  name: '--cam-rx',
  syntax: '<angle>',
  inherits: true,
  initialValue: '0deg'
});
CSS.registerProperty({
  name: '--cam-tz',
  syntax: '<length>',
  inherits: true,
  initialValue: '0px'
});
```

### 阶段 C — View 切换 + 回正（550ms – 1050ms）

**做什么**：在摄像机旋转到约 60–65deg 时（画面最"扁"），执行 display 切换，然后摄像机继续旋转到 75deg 再回落到 0deg（或一个小的俯视角如 5deg，暗示播放界面的视角是微俯视）。

**这是最关键的衔接**。两种策略：

**策略 1 — 硬切 + 运动掩盖**

在画面因透视被压到极窄的瞬间（约 65deg），直接：
```js
mainView.style.display = 'none';
playbackView.style.display = '';
```
因为此刻画面高度只剩正常的 ~cos(65°)≈42%，加上运动模糊感，人眼几乎不会察觉切换。

**策略 2 — 交叉淡入**

在 55–75deg 区间内，mainView opacity 1→0，playbackView opacity 0→1。两者叠加显示一小段时间。这更平滑但需要两个 view 同时可见（性能略高）。

**我推荐策略 2**，原因是策略 1 在低帧率设备上可能闪一下。

切换后，摄像机需要从当前角度回正：

```
--cam-rx:  75deg → 0deg (或 5deg)
--cam-tz:  300px → 0px
```

但这里有个问题：**回正方向和来时相同，会产生"回头"的感觉**，而不是"到达桌面上方"。

解决方案：**切换 view 的同时翻转 transform-origin**。

```js
// view 切换时
scene.style.transformOrigin = 'center top';   // 改为顶部
```

这样从 75deg → 0deg 的回正动画，视觉上是"从上方看下来慢慢摆正"，而不是原路返回。这就让"低头"的动作闭环了：

```
阶段B: origin=bottom, 0→75deg  （头从正前方往下低）
切换origin
阶段C: origin=top,   75→0deg   （视线从斜下方摆正到正下方）
```

### 阶段 D — CD 入场（900ms – 1400ms）

**做什么**：在摄像机接近回正的最后阶段，CD 从屏幕上方滑入 CD 机中央。

```css
.cd-disc.entering {
  animation: cdSlideIn 0.5s cubic-bezier(0.34, 1.4, 0.64, 1) forwards;
}
@keyframes cdSlideIn {
  from {
    transform: translateY(-120%) scale(0.8);
    opacity: 0;
  }
  60% {
    opacity: 1;
  }
  to {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}
```

带一点 overshoot（`1.4` 在贝塞尔曲线里）模拟 CD 落入卡槽的弹性。之后 glass cover 缓缓关闭（opacity 动画）。

---

## 阶段时间线总览

```
时间(ms)  0    200    400    550    700    900    1100   1400
          |─A──|      |      |      |      |      |      |
          |    |──────B(摄像机下俯)──|      |      |      |
          |    |      |      |──C(交叉切换+回正)──|      |
          |    |      |      |      |      |──D(CD入场)──|
```

阶段间有 ~100–150ms 的重叠，这正是关键——**所有阶段不应串行等待，而是用 overlap 制造流畅感**。

---

**1. RAF 循环 vs WAAPI vs CSS transition？**

我倾向 WAAPI（Web Animations API）

**2. 两个 view 是否需要同时存在于 DOM 里？**

以现在的结构（`display: none` 切换），在交叉淡入阶段会有问题。建议改为用 `visibility: hidden` + `opacity: 0` + `pointer-events: none` 来"隐藏"，让两个 view 始终在布局中，3D 变换才能同时作用于两者。

**3. `transform-origin` 中途切换会不会跳？**

会，如果直接改。需要在切换 origin 的同时计算一个补偿 translate 值来抵消跳变。公式大致是：

```
补偿ΔY = height × (1 - cos(currentAngle)) × (newOriginY - oldOriginY)
```

或者更简单的办法：**不切 origin，而是把"回正"做成继续正向旋转到 ~90deg 以上**，即 75deg → 90deg+ 的很短一段，在 90deg（完全侧面，不可见）时切 view 并重置为从小角度（如 15deg）回正到 0deg。这消除了 origin 问题，但总时长会略长。