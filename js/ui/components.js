/**
 * components.js — UI 组件：Cover Flow、进度条、CD 交互
 */
import state from '../core/state.js';
import { audioEngine } from '../core/audioEngine.js';
import { transitionToPlayback, transitionToMain } from './viewManager.js';
import { loadAlbumDetail } from '../core/dataLoader.js';
import { extractColors, startDynamicBackground, stopDynamicBackground } from '../utils/colorExtractor.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── DOM refs ─────────────────────────────────────────────
const coverFlow        = document.getElementById('cover-flow');
const albumInfoContainer = document.querySelector('.album-info');
const albumTitleEl     = document.getElementById('album-title-display');
const albumArtistEl    = document.getElementById('album-artist-display');
const searchOverlay    = document.getElementById('search-overlay');
const searchInput      = document.getElementById('search-input');
const settingsPanel    = document.getElementById('settings-panel');
const settingsBackdrop = document.getElementById('settings-backdrop');
const settingsBtn      = document.getElementById('settings-btn');
const progressContainer= document.getElementById('progress-container');
const progressBar      = document.getElementById('progress-bar');
const progressTooltip  = document.getElementById('progress-tooltip');
const progressIndicator= document.getElementById('progress-indicator');
const currentTrackName = document.getElementById('current-track-name');
const currentTimeDisp  = document.getElementById('current-time-display');
const playPauseBtn     = document.getElementById('play-pause-btn');
const prevBtn          = document.getElementById('prev-btn');
const nextBtn          = document.getElementById('next-btn');
const backBtn          = document.getElementById('back-btn');
const volumeSlider     = document.getElementById('volume-slider');
const cdDisc           = document.getElementById('cd-disc');
const cdCoverImg       = document.getElementById('cd-cover-img');
const bgCanvas         = document.getElementById('bg-canvas');

function showBackButton() {
  backBtn.classList.remove('hidden-back-btn');
  backBtn.classList.add('show-back-btn');
}

function hideBackButton() {
  backBtn.classList.remove('show-back-btn');
  backBtn.classList.add('hidden-back-btn');
}

// ── Cover Flow ────────────────────────────────────────────
const VISIBLE_SIDES = 3;
const SPACING = [0, 360, 460, 540]; // translateX per distance from center (even wider first gap)
const ROTY    = [0, 45,  65,  85];  // rotateY degrees per distance (steeply increasing)
const DEPTH   = [0, -60, -130, -200]; // translateZ per distance (reduced perspective depth by half)

// ease-out curve (反指数): fast start, decelerating end
const EASE_OUT = 'cubic-bezier(0,0,0.2,1)';

let _isDragging = false;
let _dragStartX = 0;
let _dragDelta  = 0;
let _lastNavDir = 1; // last nav direction (±1), drives circular fly-out side
let _flowNavToken = 0; // cancels in-flight multi-step navigation when a new nav starts
let _startupDropArmed = true; // only the very first visible batch gets the startup drop

// Live DOM map: albumIdx → card element (avoids full rebuilds on navigate)
let _cfCards = new Map();

/**
 * Relative position of albumIdx from center, adjusted for circular wrapping.
 * Result is always in the range (-len/2, len/2].
 */
function _wrappedRelPos(albumIdx, center, len) {
  let pos = albumIdx - center;
  if (pos >  len / 2) pos -= len;
  if (pos < -len / 2) pos += len;
  return pos;
}

/**
 * Ordered list of {albumIdx, pos} for all cards that should be visible.
 * Range is clamped so that when len < 2*VISIBLE_SIDES+1, the loop never
 * wraps all the way around and assigns the center album a wrong position.
 */
function _visibleSet(center, len) {
  const result = [];
  const seen   = new Set();
  const left   = Math.min(VISIBLE_SIDES, Math.floor((len - 1) / 2));
  const right  = Math.min(VISIBLE_SIDES, Math.ceil((len - 1) / 2));
  for (let d = -left; d <= right; d++) {
    const idx = ((center + d) % len + len) % len;
    if (!seen.has(idx)) {
      seen.add(idx);
      result.push({ idx, pos: d });
    }
  }
  return result;
}

function _cardTransformForPos(relPos) {
  const absPos = Math.abs(relPos);
  const sign = relPos < 0 ? -1 : 1;
  const scale = absPos === 0 ? 1.2 : 1;
  return `translateX(${sign * SPACING[absPos]}px) rotateY(${-sign * ROTY[absPos]}deg) translateZ(${DEPTH[absPos]}px) scale(${scale})`;
}

/**
 * Render / update the Cover Flow.
 * @param {boolean} animate  true = smooth CSS transition, false = instant rebuild
 */
export function renderCoverFlow(animate = false) {
  const albums = state.albums;
  const len    = albums.length;
  if (!len) {
    coverFlow.innerHTML = `
      <div class="empty-state">
        <h2>没有找到专辑</h2>
        <p>当前所选目录下没有可用音频文件。
           可以在设置中更换目录，或检查每张专辑是否位于独立子文件夹内。</p>
      </div>`;
    albumTitleEl.textContent = '';
    albumArtistEl.textContent = '';
    return;
  }

  const center        = state.coverFlowIndex;
  const visible       = _visibleSet(center, len);
  const visibleIdxSet = new Set(visible.map(v => v.idx));

  if (!animate) {
    // Full instant rebuild (initial load / after returning from playback)
    const applyStartupDrop = _startupDropArmed && document.body.classList.contains('is-startup');
    coverFlow.innerHTML = '';
    _cfCards.clear();
    for (const { idx, pos } of visible) {
      const card = _buildCard(albums[idx], idx, pos, false, applyStartupDrop);
      coverFlow.appendChild(card);
      _cfCards.set(idx, card);
    }
    _startupDropArmed = false;
  } else {
    // Determine which card exits: for large libs a card naturally leaves the visible
    // window; for small libs (all cards always visible) we force-exit the extreme card
    // on the side opposite to navigation so there is never a teleport.
    const exitCandidates = new Set();
    for (const [idx] of _cfCards) {
      if (!visibleIdxSet.has(idx)) exitCandidates.add(idx);
    }
    if (exitCandidates.size === 0) {
      // All current cards stay visible — pick the extreme card on the opposite side
      let extremeIdx = -1, extremePos = _lastNavDir > 0 ? Infinity : -Infinity;
      for (const [idx, card] of _cfCards) {
        const p = parseInt(card.dataset.pos, 10);
        if (_lastNavDir > 0 ? p < extremePos : p > extremePos) { extremePos = p; extremeIdx = idx; }
      }
      if (extremeIdx !== -1) exitCandidates.add(extremeIdx);
    }

    for (const idx of exitCandidates) {
      const card = _cfCards.get(idx);
      const sign = parseInt(card.dataset.pos, 10) < 0 ? -1 : 1;
      card.style.transition = `transform 0.4s ${EASE_OUT}, opacity 0.3s ease`;
      card.style.transform  = `translateX(${sign * 600}px) rotateY(${-sign * 95}deg) translateZ(-600px)`;
      card.style.opacity    = '0';
      setTimeout(() => card.remove(), 400);
      _cfCards.delete(idx);
    }

    // Fly in cards that are newly visible (including the wrap-around re-entry)
    for (const { idx, pos } of visible) {
      if (!_cfCards.has(idx)) {
        const sign = pos < 0 ? -1 : 1;
        const card = _buildCard(albums[idx], idx, pos, true /* skipPos */);
        card.style.transform  = `translateX(${sign * 600}px) rotateY(${-sign * 95}deg) translateZ(-600px)`;
        card.style.opacity    = '0';
        card.style.transition = 'none';
        coverFlow.appendChild(card);
        _cfCards.set(idx, card);
      }
    }

    // Two-frame flush so initial off-screen transform is painted before animating
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const { idx, pos } of visible) {
          const card = _cfCards.get(idx);
          if (card) _positionCard(card, idx, pos, true);
        }
      });
    });
  }

  _updateAlbumInfo(albums[center], animate);
}

/** Create a card DOM element. skipPos = true: don't apply transform yet (for animated entry). */
function _buildCard(album, albumIdx, relPos, skipPos = false, startupDrop = false) {
  const card = document.createElement('div');
  // For initial render / full rebuild, add 'ready' immediately to the center card
  card.className = 'album-card'
    + (relPos === 0 ? ' center ready' : '')
    + (startupDrop ? ' startup-drop' : '');
  card.dataset.index = albumIdx;
  card.dataset.pos = relPos; // Remember relative pos for fly-out calculation

  const coverDiv = document.createElement('div');
  coverDiv.className = 'album-cover';
  if (album.cover_url) {
    const img = document.createElement('img');
    img.src = album.cover_url;
    img.alt = album.title;
    img.draggable = false;
    coverDiv.appendChild(img);
  } else {
    coverDiv.innerHTML = `<div class="album-cover-placeholder">🎵</div>`;
  }
  card.appendChild(coverDiv);

  if (relPos === 0) {
    card.appendChild(_buildCdPeek(album));
  }

  if (!skipPos) {
    const absPos = Math.abs(relPos);
    card.style.transform = _cardTransformForPos(relPos);
    card.style.opacity   = '1';
    card.style.zIndex    = String(VISIBLE_SIDES - absPos);
    
    // Add custom property for stagger delay (left to right)
    // Leftmost card (relPos = -3) gets 0s, rightmost (+3) gets ~0.42s
    if (startupDrop) {
      const delay = (relPos + VISIBLE_SIDES) * 0.07;
      card.style.setProperty('--startup-delay', `${delay}s`);
    }
  }

  _bindClick(card, album, albumIdx);
  return card;
}

/** Update an existing card's 3-D position (and rebind click handler). */
function _positionCard(card, albumIdx, pos, animate) {
  const absPos  = Math.abs(pos);
  const sign    = pos < 0 ? -1 : 1;
  const opacity = '1';

  card.dataset.pos = pos;
  card.classList.toggle('center', pos === 0);
  card.classList.remove('ready');

  // Sync cd-peek element
  const existingPeek = card.querySelector('.cd-peek');
  if (pos === 0 && !existingPeek) {
    card.appendChild(_buildCdPeek(state.albums[albumIdx]));
  } else if (pos !== 0 && existingPeek) {
    existingPeek.remove();
  }

  card.style.transition = animate
    ? `transform 0.38s ${EASE_OUT}, opacity 0.38s ${EASE_OUT}`
    : '';
    
  if (absPos === 0 && animate) {
    // 目标是在中心：先以原有大小(scale 1)平移到中心，延迟后再弹性放大
    // 清除可能存在的之前的 timeouts
    if (card.dataset.scaleTimeout) clearTimeout(parseInt(card.dataset.scaleTimeout));
    if (card.dataset.readyTimeout) clearTimeout(parseInt(card.dataset.readyTimeout));
    
    // 第一步：先以 scale(1) 移动到中间位置
    card.style.transform = `translateX(0px) rotateY(0deg) translateZ(0px) scale(1)`;
    card.style.opacity   = String(opacity);
    card.style.zIndex    = String(VISIBLE_SIDES);
    
    // 第二步：等待平移完成后，执行弹跳变大
    const timeoutId = setTimeout(() => {
      card.style.transition = `transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)`; // 弹性动画
      card.style.transform = `translateX(0px) rotateY(0deg) translateZ(0px) scale(1.2)`;
      
      // 第三步：放大基本完成后再允许 hover（避免动画渲染冲突截断卡片本应有的变大过程）
      const readyTimeoutId = setTimeout(() => {
        card.classList.add('ready');
      }, 400);
      card.dataset.readyTimeout = readyTimeoutId.toString();
    }, 380); // 等待上面 0.38s 的平移完成
    
    card.dataset.scaleTimeout = timeoutId.toString();
  } else {
    // 非中心卡片或者非动画状态，直接应用标准 transform
    if (card.dataset.scaleTimeout) clearTimeout(parseInt(card.dataset.scaleTimeout));
    if (card.dataset.readyTimeout) clearTimeout(parseInt(card.dataset.readyTimeout));
    delete card.dataset.scaleTimeout;
    delete card.dataset.readyTimeout;
    card.style.transform = _cardTransformForPos(pos);
    card.style.opacity   = String(opacity);
    card.style.zIndex    = String(VISIBLE_SIDES - absPos);
    if (!animate && absPos === 0) card.classList.add('ready');
  }

  _bindClick(card, state.albums[albumIdx], albumIdx);
}

/** Rebind click so the handler always sees the current center index. */
function _bindClick(card, album, albumIdx) {
  card.onclick = () => {
    const len = state.albums.length;
    const pos = _wrappedRelPos(albumIdx, state.coverFlowIndex, len);
    if (pos === 0) {
      enterPlayback(album);
    } else {
      navigateFlowBySteps(Math.sign(pos), Math.abs(pos));
    }
  };
}

function _buildCdPeek(album) {
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
  return peek;
}

let _albumInfoTimeoutId = null;

/** Fade-swap the album title / artist text. */
function _updateAlbumInfo(album, animate) {
  if (!album) return;
  
  if (_albumInfoTimeoutId) {
    clearTimeout(_albumInfoTimeoutId);
    _albumInfoTimeoutId = null;
  }
  
  if (animate) {
    albumInfoContainer.classList.add('hidden');
    // 当动画停止且专辑被挪到中心并且准备“放大”时再出现
    // 卡片平移需 380ms，可以在这之后再更新内容并渐显出来
    _albumInfoTimeoutId = setTimeout(() => {
      albumTitleEl.textContent  = album.title;
      albumArtistEl.textContent = album.artist;
      albumInfoContainer.classList.remove('hidden');
    }, 450); // 在它开始“弹性变大”的时候浮现 (380ms平移 + 少量额外延迟使得动画重叠)
  } else {
    albumInfoContainer.classList.remove('hidden');
    albumTitleEl.textContent  = album.title;
    albumArtistEl.textContent = album.artist;
  }
}

async function animateReturnToCoverFlow() {
  const len = state.albums.length;
  if (!len) return;

  albumInfoContainer.classList.add('hidden');

  for (const [idx, card] of _cfCards) {
    const pos = _wrappedRelPos(idx, state.coverFlowIndex, len);
    const absPos = Math.abs(pos);

    if (card.dataset.scaleTimeout) clearTimeout(parseInt(card.dataset.scaleTimeout));
    if (card.dataset.readyTimeout) clearTimeout(parseInt(card.dataset.readyTimeout));
    delete card.dataset.scaleTimeout;
    delete card.dataset.readyTimeout;

    card.dataset.pos = pos;
    card.classList.toggle('center', pos === 0);
    card.classList.remove('ready');
    card.style.zIndex = String(VISIBLE_SIDES - absPos);

    if (pos !== 0) {
      card.style.transition =
        `transform 0.56s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.34s ease`;
      card.style.opacity = '1';
    } else {
      const cover = card.querySelector('.album-cover');
      const peek = card.querySelector('.cd-peek') || _buildCdPeek(state.albums[idx]);
      if (!peek.parentNode) card.appendChild(peek);

      card.style.transition = 'none';
      card.style.opacity = '1';
      card.style.transform = _cardTransformForPos(0);

      if (cover) {
        cover.style.transition = 'transform 0.46s cubic-bezier(0.22, 1, 0.36, 1)';
      }
      peek.style.transition = 'opacity 0.2s ease 0.26s';
      peek.style.opacity = '1';
      peek.style.transform = 'translate(-50%, -50%)';
    }
  }

  requestAnimationFrame(() => {
    for (const [idx, card] of _cfCards) {
      const pos = _wrappedRelPos(idx, state.coverFlowIndex, len);
      if (pos !== 0) {
        card.style.transform = _cardTransformForPos(pos);
      } else {
        const cover = card.querySelector('.album-cover');
        const peek = card.querySelector('.cd-peek');
        if (cover) cover.style.transform = 'translateX(0px)';
        if (peek) peek.style.opacity = '0';
      }
    }
  });

  await delay(620);

  for (const [idx, card] of _cfCards) {
    const pos = _wrappedRelPos(idx, state.coverFlowIndex, len);
    _positionCard(card, idx, pos, false);

    const cover = card.querySelector('.album-cover');
    const peek = card.querySelector('.cd-peek');
    card.style.transition = '';
    if (cover) {
      cover.style.transition = '';
      cover.style.transform = '';
      cover.style.opacity = '';
    }
    if (peek) {
      peek.style.transition = '';
      if (pos === 0) {
        peek.style.opacity = '';
        peek.style.transform = '';
      }
    }
  }

  const album = state.albums[state.coverFlowIndex];
  if (album) {
    albumTitleEl.textContent = album.title;
    albumArtistEl.textContent = album.artist;
  }
  albumInfoContainer.classList.remove('hidden');
}

// ── Cover Flow controls (keyboard / drag / touch) ─────────
export function initCoverFlowControls() {
  const stage = document.querySelector('.cover-flow-stage');

  document.addEventListener('keydown', e => {
    if (state.view !== 'main') return;
    if (searchOverlay.classList.contains('visible')) {
      return;
    } else if (['ArrowLeft', 'ArrowRight', 'Enter', ' ', '/'].includes(e.key)) {
      e.preventDefault();
    }
    if (e.key === 'ArrowLeft')  navigateFlow(-1);
    if (e.key === 'ArrowRight') navigateFlow(1);
    if (e.key === 'Enter' || e.key === ' ') {
      const album = state.albums[state.coverFlowIndex];
      if (album) enterPlayback(album);
    }
    if (e.key === '/') {
      searchOverlay.classList.add('visible');
      searchInput.focus();
    }
  });

  // 使用一个较小的 debounce 标记防止 trackpad 连发，但不使用死板的时间间隔
  let isWheeling = false;
  window.addEventListener('wheel', e => {
    if (state.view !== 'main') return;
    if (isWheeling) return;
    isWheeling = true;
    
    // 触发滑动，并且传入参数让滚动更平滑
    if (e.deltaY > 0) {
      navigateFlow(1);
    } else if (e.deltaY < 0) {
      navigateFlow(-1);
    }
    
    // 松开滚轮节流限制的时间根据设备特性自动调整。如果是机械滚轮通常会立刻释放。
    setTimeout(() => {
      isWheeling = false;
    }, 60);
  });

  stage.addEventListener('mousedown', e => {
    _isDragging = true;
    _dragStartX = e.clientX;
    _dragDelta  = 0;
  });
  window.addEventListener('mousemove', e => {
    if (!_isDragging) return;
    _dragDelta = e.clientX - _dragStartX;
  });
  window.addEventListener('mouseup', () => {
    if (!_isDragging) return;
    _isDragging = false;
    if (_dragDelta > 60)       navigateFlow(-1);
    else if (_dragDelta < -60) navigateFlow(1);
    _dragDelta = 0;
  });

  stage.addEventListener('touchstart', e => {
    _dragStartX = e.touches[0].clientX;
  }, { passive: true });
  stage.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - _dragStartX;
    if (dx > 50)       navigateFlow(-1);
    else if (dx < -50) navigateFlow(1);
  });
}

function navigateFlow(dir) {
  _flowNavToken++;
  navigateFlowStep(dir);
}

function navigateFlowStep(dir) {
  _lastNavDir = dir;
  const len = state.albums.length;
  if (!len) return;
  // Circular: wrap around both ends
  const next = (state.coverFlowIndex + dir + len) % len;
  state.set('coverFlowIndex', next);
  renderCoverFlow(true);
}

async function navigateFlowBySteps(dir, steps, { stepDelay } = {}) {
  if (!steps) return true;

  const token = ++_flowNavToken;
  const delayMs = stepDelay ?? Math.max(45, Math.min(90, Math.round(360 / steps)));

  for (let i = 0; i < steps; i++) {
    if (token !== _flowNavToken) return false;
    navigateFlowStep(dir);
    if (i < steps - 1) {
      await delay(delayMs);
    }
  }

  return token === _flowNavToken;
}

// ── CD Rotation (JS-driven RAF, replaces CSS animation) ───
let _cdAngle    = 0;       // current rotation angle in degrees
let _cdRunning  = false;   // RAF loop active?
let _cdLastTs   = null;    // last RAF timestamp
let _cdDragging = false;   // is user dragging the disc?
export function isCdDragging() {
  return _cdDragging || _cdInertiaActive; // Treat inertia as still dragging for the purpose of hiding progress UI
}

let _previewTime = null; // keeps track of the intended time across concurrent drag/inertia actions

// Helpers for inertia to call
function _dispatchInertiaPreview() {
  const album = state.currentAlbum;
  if (!album || _previewTime === null) return;
  const timeDelta = (_cdInertiaVelocity / 360) * 180;
  _previewTime = Math.max(0, Math.min(album.total_duration, _previewTime + timeDelta));
  updateProgressBar(_previewTime);
}

async function _commitDragSeek() {
  // Allow UI to dynamically hide again after a small delay
  setTimeout(() => {
    isProgressHoverLocked = false;
  }, 1000); 

  const album = state.currentAlbum;
  if (!album || _previewTime === null) return;

  const targetTime = _previewTime;
  await audioEngine.seekAndPlay(targetTime);
  showPlaybackProgressInfoByDrag();
  
  // Clear the state only if user didn't start a new drag while we were seeking
  if (!_cdDragging && !_cdInertiaActive) {
    _previewTime = null;
  }

  state.set('isPlaying', true);
  updatePlayPauseBtn();
}

const CD_DEG_PER_SEC = 90; // 4 s per revolution

export let isProgressHoverLocked = false;
let _playbackProgressForceShowTimeout = null;

function showPlaybackProgressInfoByDrag(duration = 5000) {
  progressContainer?.classList.add('visible-dragging');

  if (_playbackProgressForceShowTimeout) {
    clearTimeout(_playbackProgressForceShowTimeout);
  }

  const tryHideTogether = () => {
    // const trackInfo = document.querySelector('.track-info');
    // const trackInfoPinned = trackInfo?.classList.contains('force-show');

    // if (isCdDragging() || isProgressHoverLocked || trackInfoPinned) {
    //   _playbackProgressForceShowTimeout = setTimeout(tryHideTogether, 250);
    //   return;
    // }
    progressContainer?.classList.remove('visible-dragging');
    _playbackProgressForceShowTimeout = null;
  };

  _playbackProgressForceShowTimeout = setTimeout(tryHideTogether, duration);
}

// We'll manage inertia in the main loop or as a distinct feature
let _cdInertiaVelocity = 0; // degrees per frame (or per ms)
let _cdInertiaActive = false;

function _cdLoop(ts) {
  if (!_cdLastTs) _cdLastTs = ts;
  const dt = (ts - _cdLastTs) / 1000;
  _cdLastTs = ts;

  if (_cdInertiaActive && !_cdDragging) {
    // Apply inertia
    _cdAngle += _cdInertiaVelocity;
    // Decelerate (friction)
    _cdInertiaVelocity *= 0.98; // 进一步减小摩擦力（原本0.94），让惯性滑行时间更长、更丝滑
    
    if (Math.abs(_cdInertiaVelocity) < 0.15) {
      _cdInertiaActive = false;
      _cdInertiaVelocity = 0;
      showPlaybackProgressInfoByDrag();
      
      // When inertia fully stops, commit the total accumulated seek
      _commitDragSeek();
    } else {
      // Still spinning with inertia update progress dynamically
      _dispatchInertiaPreview();
    }
  } else if (state.isPlaying && !_cdDragging) {
    // Advance rotation normally
    _cdAngle += CD_DEG_PER_SEC * dt;
  }

  // Only write the transform when not actively user-dragging
  if (!_cdDragging) {
    cdDisc.style.transform = `rotate(${_cdAngle}deg)`;
  }

  if (_cdRunning) requestAnimationFrame(_cdLoop);
}

function startCdAnimation() {
  if (_cdRunning) return;
  _cdAngle   = 0;
  _cdLastTs  = null;
  _cdRunning = true;
  requestAnimationFrame(_cdLoop);
}

function stopCdAnimation() {
  _cdRunning = false;
  _cdAngle   = 0;
  _cdLastTs  = null;
  cdDisc.style.transform = '';
}

// ── Enter Playback ────────────────────────────────────────
let _bgCleanup = null;

async function enterPlayback(albumSummary) {
  _flowNavToken++;
  const len = state.albums.length;

  // 1. Cinematic cover-flow exit —————————————————————————
  for (const [idx, card] of _cfCards) {
    const pos = _wrappedRelPos(idx, state.coverFlowIndex, len);
    if (pos < 0) {
      // Left cards fly out to the left with rotation
      card.style.transition = 'transform 0.45s cubic-bezier(0.4,0,1,1), opacity 0.35s ease';
      card.style.transform  = `translateX(-130vw) rotateY(-60deg)`;
      card.style.opacity    = '0';
    } else if (pos > 0) {
      // Right cards fly out to the right
      card.style.transition = 'transform 0.45s cubic-bezier(0.4,0,1,1), opacity 0.35s ease';
      card.style.transform  = `translateX(130vw) rotateY(60deg)`;
      card.style.opacity    = '0';
    } else {
      const cover = card.querySelector('.album-cover');
      const peek = card.querySelector('.cd-peek');

      if (cover) {
        cover.style.transition = 'transform 0.36s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease';
        cover.style.transform = 'translateX(-320px)';
      }

      if (peek) {
        peek.style.transition = 'opacity 0.16s ease';
        peek.style.opacity = '1';
        peek.style.transform = 'translate(-50%, -50%)';
      }
    }
  }

  // Fade out album info text simultaneously
  // Hide album info
  albumInfoContainer.classList.add('hidden');
  
  // Clear and hide search
  if (searchInput) searchInput.value = '';
  if (searchOverlay) searchOverlay.classList.remove('visible');

  // 2. Load album detail while the animation plays ————————
  const albumDetailPromise = loadAlbumDetail(albumSummary.detail_url);

  // 3. Cross-fade into the playback view ——————————————————
  showBackButton();
  await transitionToPlayback(async () => {
    let albumDetail;
    try {
      albumDetail = await albumDetailPromise;
    } catch (e) {
      console.error('加载专辑详情失败', e);
      throw e;
    }

    state.set('currentAlbum', albumDetail);
    audioEngine.loadAlbum(albumDetail);
    setupProgressBar(albumDetail);
    updateCdCover(albumDetail.cover_url);
    setupDynamicBackground(albumDetail.cover_url);
  });

  // 4. Start playback ————————————————————————————————————
  const album = state.currentAlbum;
  const savedKey = `playersky_progress_${album?.id}`;
  const savedRaw = album?.id ? localStorage.getItem(savedKey) : null;
  const savedTime = savedRaw !== null ? parseFloat(savedRaw) : 0;
  // 若已播完（距结尾不足 3 秒），从头开始
  const startTime = (album && savedTime > 0 && savedTime < album.total_duration - 3) ? savedTime : 0;
  await audioEngine.seekAndPlay(startTime);
  if (!audioEngine.isPlaying) return; // back was pressed during load
  state.set('isPlaying', true);
  updatePlayPauseBtn();
  startCdAnimation();

  // Close the glass cover with a short delay for drama (temporarily disabled as glass is removed)
  // setTimeout(() => cdGlass.classList.add('closed'), 400);
}

function updateCdCover(coverUrl) {
  if (coverUrl) {
    cdCoverImg.src = coverUrl;
    cdCoverImg.style.display = 'block';
  } else {
    cdCoverImg.style.display = 'none';
  }
}

function setupDynamicBackground(coverUrl) {
  if (_bgCleanup) { _bgCleanup(); _bgCleanup = null; }
  const fallback = [
    { r: 40, g: 30, b: 80 }, { r: 20, g: 60, b: 90 }, { r: 60, g: 20, b: 50 },
  ];
  if (!coverUrl) {
    _bgCleanup = startDynamicBackground(bgCanvas, fallback);
    return;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload  = () => { _bgCleanup = startDynamicBackground(bgCanvas, extractColors(img, 3)); };
  img.onerror = () => { _bgCleanup = startDynamicBackground(bgCanvas, fallback); };
  img.src = coverUrl;
}

// ── Progress Bar ──────────────────────────────────────────
let _progressSegments = [];

function setupProgressBar(albumData) {
  progressBar.innerHTML = '';
  _progressSegments = [];
  albumData.tracks.forEach((track, i) => {
    const pct = (track.duration / albumData.total_duration) * 100;
    const seg  = document.createElement('div');
    seg.className = 'track-segment';
    seg.style.width = `${pct}%`;
    seg.dataset.trackIndex = i;

    const fill = document.createElement('div');
    fill.className = 'segment-fill';
    seg.appendChild(fill);
    progressBar.appendChild(seg);
    _progressSegments.push({ el: seg, fill, track });
  });
}

export function updateProgressBar(albumTime) {
  const album = state.currentAlbum;
  if (!album) return;

  _progressSegments.forEach(({ fill, track }) => {
    const trackEnd = track.start_time + track.duration;
    let pct;
    if (albumTime >= trackEnd)              pct = 100;
    else if (albumTime <= track.start_time) pct = 0;
    else pct = ((albumTime - track.start_time) / track.duration) * 100;
    fill.style.width = `${pct}%`;
  });
  let tmpIndex = -1;
  for (let i = _progressSegments.length - 1; i >= 0; i--) {
    if (albumTime >= _progressSegments[i].track.start_time) {
      tmpIndex = i;
      break;
    }
  }

  const track = album.tracks[tmpIndex];
  if (track) {
    currentTrackName.textContent = track.title;
    // 限制时间范围：最小为0，最大为歌曲总时长，防止切歌边界或末尾溢出
    const trackTime = Math.max(0, Math.min(track.duration, albumTime - track.start_time));
    currentTimeDisp.textContent = `${fmtTime(trackTime)} / ${fmtTime(track.duration)}`;
  }
}

export function initProgressBar() {
  const wrap = document.getElementById('progress-bar-wrap');
  const SNAP_PX = 8;

  // Returns snapped { x, hoverTime } — x aligns to the left edge of the right segment
  function applySnap(rawX, wrapRect, album) {
    for (let i = 1; i < _progressSegments.length; i++) {
      const segLeft = _progressSegments[i].el.getBoundingClientRect().left - wrapRect.left;
      if (Math.abs(rawX - segLeft) < SNAP_PX) {
        return { x: segLeft, hoverTime: album.tracks[i].start_time };
      }
    }
    const frac = Math.max(0, Math.min(1, rawX / wrapRect.width));
    return { x: rawX, hoverTime: frac * album.total_duration };
  }

  wrap.addEventListener('mousemove', e => {
    const rect = wrap.getBoundingClientRect();
    let x = e.clientX - rect.left;

    const album = state.currentAlbum;
    if (album) {
      const { x: snappedX, hoverTime } = applySnap(x, rect, album);
      x = snappedX;
      const hoverTrack = findTrackAtTime(album.tracks, hoverTime);
      progressTooltip.style.opacity = '1';
      progressTooltip.style.left = `${x}px`;
      progressTooltip.querySelector('.tooltip-track-name').textContent = hoverTrack.title;
      const tTime = hoverTime - hoverTrack.start_time;
      progressTooltip.querySelector('.tooltip-time').textContent =
        `${fmtTime(tTime)} / ${fmtTime(hoverTrack.duration)}`;
    }

    progressIndicator.style.opacity = '1';
    progressIndicator.style.left = `${x}px`;
  });

  wrap.addEventListener('mouseleave', () => {
    progressIndicator.style.opacity = '0';
    progressTooltip.style.opacity = '0';
  });

  wrap.addEventListener('click', async e => {
    const album = state.currentAlbum;
    if (!album) return;
    const rect = wrap.getBoundingClientRect();
    const { hoverTime: seekTime } = applySnap(e.clientX - rect.left, rect, album);

    // Optimistic update: jump to new position immediately before audio loads
    let ti = 0;
    for (let i = album.tracks.length - 1; i >= 0; i--) {
      if (seekTime >= album.tracks[i].start_time) { ti = i; break; }
    }
    state.set('currentTrackIndex', ti);
    updateProgressBar(seekTime);

    await audioEngine.seekAndPlay(seekTime);
    state.set('isPlaying', true);
    updatePlayPauseBtn();
  });
}

// ── CD Disc Drag → visual rotation + seek ────────────────
export function initCdDrag() {
  let _lastAngle = 0;
  
  // For velocity tracking
  let _lastMoveTime = 0;
  let _velocityPoints = [];

  function getAngle(e, rect) {
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    return Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI);
  }

  cdDisc.addEventListener('mousedown', e => {
    _cdDragging = true;
    _cdInertiaActive = false;
    _cdInertiaVelocity = 0;
    isProgressHoverLocked = true;
    
    _lastAngle = getAngle(e, cdDisc.getBoundingClientRect());
    
    // 如果_previewTime为null说明这是这组拖拽的第一次，基于当前播放时间起算
    if (_previewTime === null) {
      _previewTime = audioEngine.currentAlbumTime;
    }
    
    _velocityPoints = [];
    _lastMoveTime = performance.now();

    // Show progress bar so the user can see where they're seeking
    progressContainer.classList.add('visible');
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!_cdDragging) return;
    const rect  = cdDisc.getBoundingClientRect();
    const angle = getAngle(e, rect);
    let delta   = angle - _lastAngle;
    
    // Unwrap the angle to avoid 180°→-180° jump
    if (delta >  180) delta -= 360;
    if (delta < -180) delta += 360;
    
    _cdAngle  += delta; // update the shared rotation state
    // Write transform directly for zero-latency visual feedback
    cdDisc.style.transform = `rotate(${_cdAngle}deg)`;
    _lastAngle = angle;
    
    // Track velocity
    const now = performance.now();
    _velocityPoints.push({ delta, dt: Math.max(1, now - _lastMoveTime) });
    if (_velocityPoints.length > 5) _velocityPoints.shift();
    _lastMoveTime = now;

    // Real-time progress preview: 360° = 180 s (3 min)
    const album = state.currentAlbum;
    if (album && _previewTime !== null) {
      const timeDelta = (delta / 360) * 180;
      _previewTime = Math.max(0, Math.min(album.total_duration, _previewTime + timeDelta));
      updateProgressBar(_previewTime);
    }
  });

  window.addEventListener('mouseup', () => {
    if (!_cdDragging) return;
    _cdDragging = false;
    
    // Calculate release velocity
    let totalDelta = 0;
    let totalDt = 0;
    for (const pt of _velocityPoints) {
      totalDelta += pt.delta;
      totalDt += pt.dt;
    }
    
    const now = performance.now();
    // If the user stopped moving for >100ms before releasing, no inertia
    if (now - _lastMoveTime < 100 && totalDt > 0) {
      const avgV = totalDelta / (totalDt / 16.666); // degrees per frame approx
      if (Math.abs(avgV) > 1.0) {
        _cdInertiaVelocity = avgV;
        _cdInertiaActive = true;
        // The _cdLoop will handle inertia and commit when done
        return;
      }
    }
    
    // If no inertia, commit immediately
    _commitDragSeek();
  });
}

// ── Playback Controls ─────────────────────────────────────
export function initPlaybackControls() {
  playPauseBtn.addEventListener('click', async () => {
    if (state.isPlaying) {
      audioEngine.pause();
      state.set('isPlaying', false);
    } else {
      await audioEngine.resume();
      state.set('isPlaying', true);
    }
    updatePlayPauseBtn();
  });

  prevBtn.addEventListener('click', () => audioEngine.prevTrack());
  nextBtn.addEventListener('click', () => audioEngine.nextTrack());

  backBtn.addEventListener('click', async () => {
    hideBackButton();
    audioEngine.pause();
    state.set('isPlaying', false);
    stopCdAnimation();
    // cdGlass.classList.remove('closed'); // HTML中已删除，避免报错
    progressContainer.classList.remove('visible');
    
    // allow background to fade out smoothly before stopping the canvas drawing
    setTimeout(() => stopDynamicBackground(), 800);
    
    await transitionToMain();
    await animateReturnToCoverFlow();
  });

  document.addEventListener('keydown', async (e) => {
    // 只有在播放界面时才生效快捷键
    if (state.view !== 'playback') return;
    
    if (e.code === 'Space') {
      e.preventDefault(); // 防止页面滚动
      if (state.isPlaying) {
        audioEngine.pause();
        state.set('isPlaying', false);
      } else {
        await audioEngine.resume();
        state.set('isPlaying', true);
      }
      updatePlayPauseBtn();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      audioEngine.prevTrack();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      audioEngine.nextTrack();
    } else if (e.code === 'Escape') {
      e.preventDefault();
      backBtn.click();
    }
  });
}

export function updatePlayPauseBtn() {
  const playIcon = `<svg viewBox="0 0 24 24" fill="currentColor" width="52" height="52"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18c.62-.39.62-1.29 0-1.69L9.54 5.98C8.87 5.55 8 6.03 8 6.82z"></path></svg>`;
  const pauseIcon = `<svg viewBox="0 0 24 24" fill="currentColor" width="52" height="52"><path d="M8 19c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v10c0 1.1.9 2 2 2zm6-12v10c0 1.1.9 2 2 2s2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2z"></path></svg>`;
  playPauseBtn.innerHTML = state.isPlaying ? pauseIcon : playIcon;
  
  // Toggle class for background theme
  if (state.isPlaying) {
    document.body.classList.add('is-playing');
  } else {
    document.body.classList.remove('is-playing');
  }
}

// ── Hover zones ───────────────────────────────────────────
export function initHoverZones() {
  const mainView     = document.getElementById('main-view');
  const playbackView = document.getElementById('playback-view');
  let playbackHideTimer = null;

  function _searchHasText() {
    return !!(searchInput && searchInput.value.trim());
  }

  function hidePlaybackUi() {
    document.getElementById('prev-btn')?.classList.remove('visible');
    document.getElementById('next-btn')?.classList.remove('visible');
    document.getElementById('play-pause-btn')?.classList.remove('visible');
    progressContainer.classList.remove('visible');
  }

  function hidePlaybackControls() {
    document.getElementById('prev-btn')?.classList.remove('visible');
    document.getElementById('next-btn')?.classList.remove('visible');
    document.getElementById('play-pause-btn')?.classList.remove('visible');
  }

  function resetPlaybackHideTimer() {
    if (playbackHideTimer) clearTimeout(playbackHideTimer);
    playbackHideTimer = setTimeout(() => {
      if (state.view !== 'playback') return;
      if (isCdDragging() || isProgressHoverLocked) return;
      hidePlaybackUi();
    }, 5000);
  }

  // Main view: top → search
  window.addEventListener('mousemove', e => {
    if (state.view !== 'main') return;
    if (state.transitioning) return; // Don't show/hide during view transitions
    
    // 根据搜索框实际高度动态计算隐藏的阈值
    let hideThreshold = 160;
    if (searchOverlay.classList.contains('visible')) {
      const rect = searchOverlay.getBoundingClientRect();
      hideThreshold = Math.max(160, rect.bottom + 40);
    }

    if (e.clientY < 120) { // 稍微扩大顶部触发区域，以免太难唤出
      searchOverlay.classList.add('visible');
    } else if (e.clientY > hideThreshold && !_searchHasText()) {
      // Don't hide the search overlay while there's text in the input
      searchInput.blur(); // Remove focus when moving away to prevent accidental input
      searchOverlay.classList.remove('visible');
    }
  });

  document.addEventListener('mouseleave', () => {
    if (state.view === 'main' && !_searchHasText()) {
      searchOverlay.classList.remove('visible');
    }
  });

  // Playback view: mousemove handling for controls & progress bar
  playbackView.addEventListener('mousemove', e => {
    if (state.view !== 'playback') return;
    resetPlaybackHideTimer();
    
    // 1. 判断 CD 高度的横向区域显隐 控制层(播放/切歌按钮)
    // CD 视觉圆心高度 (基于50% 以及向上的 57.6px 偏移)
    const cdCenterY = window.innerHeight / 2 - 57.6;
    const cdRadius = (340 * 1.28) / 2; // 近似为CD整体的物理半径
    
    // 如果鼠标没有在拖拽CD
    if (!isCdDragging()) {
      // 获取三个按钮
      const prevBtn = document.getElementById('prev-btn');
      const nextBtn = document.getElementById('next-btn');
      const playBtn = document.getElementById('play-pause-btn');

      const dist = (btn) => {
        if(!btn) return Infinity;
        const rect = btn.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        return Math.sqrt(Math.pow(e.clientX - centerX, 2) + Math.pow(e.clientY - centerY, 2));
      };

      // 靠近哪个按钮则显示哪个，给个相对宽松点触发距离
      if(prevBtn) prevBtn.classList.toggle('visible', dist(prevBtn) < 300); // 调整触发半径
      if(nextBtn) nextBtn.classList.toggle('visible', dist(nextBtn) < 300); // 调整触发半径
      if(playBtn) playBtn.classList.toggle('visible', dist(playBtn) < 60); // 触发半径等同于按钮自身半径 (120px / 2)
    } else {
      // 拖拽时仅隐藏控制按钮，底部进度区仍按鼠标位置正常显示
      hidePlaybackControls();
    }

    // 2. 判断底部进度条呼出 
    // CD外框最下边缘
    const cdBottomY = cdCenterY + cdRadius;
    
    if (e.clientY > cdBottomY + 20) {
      progressContainer.classList.add('visible');
    } else if (e.clientY < cdBottomY - 30 && !isCdDragging() && !isProgressHoverLocked) {
      progressContainer.classList.remove('visible');
    }
  });

  playbackView.addEventListener('mouseleave', () => {
    if (playbackHideTimer) clearTimeout(playbackHideTimer);
    if (state.view !== 'playback') return;
    hidePlaybackUi();
  });
}

// ── Settings Panel ────────────────────────────────────────
export function initSettings() {
  const open  = () => { settingsPanel.classList.add('visible'); settingsBackdrop.classList.add('visible'); };
  const close = () => { settingsPanel.classList.remove('visible'); settingsBackdrop.classList.remove('visible'); };

  settingsBtn?.addEventListener('click', open);
  settingsBackdrop?.addEventListener('click', close);

  volumeSlider?.addEventListener('input', e => {
    const v = e.target.value / 100;
    state.set('volume', v);
    audioEngine.setVolume(v);
  });
}

// ── Search ────────────────────────────────────────────────
export function initSearch() {
  searchInput?.addEventListener('keydown', async e => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchInput.blur();
      searchOverlay.classList.remove('visible');
    }
    if (e.key === 'Enter') {
      e.stopPropagation(); // 防止事件冒泡到外层触发直接播放
      e.preventDefault();

      const q = searchInput.value.toLowerCase().trim();
      if (!q) return;
      const idx = state.albums.findIndex(a =>
        a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q)
      );
      if (idx >= 0 && idx !== state.coverFlowIndex) {
        // Calculate shortest path
        const len = state.albums.length;
        // distance if going right
        const distRight = (idx - state.coverFlowIndex + len) % len;
        // distance if going left
        const distLeft = (state.coverFlowIndex - idx + len) % len;
        
        const dir = distRight <= distLeft ? 1 : -1;
        const steps = Math.min(distRight, distLeft);
        const stepDelay = Math.max(20, Math.min(100, 500 / steps));
        const arrived = await navigateFlowBySteps(dir, steps, { stepDelay });

        if (arrived) {
          searchInput.value = '';
          searchOverlay.classList.remove('visible');
          searchInput.blur();
        }
      } else if (idx === state.coverFlowIndex) {
        searchInput.value = '';
        searchOverlay.classList.remove('visible');
      }
    }
  });
}

// ── Utilities ─────────────────────────────────────────────
function fmtTime(sec) {
  sec = Math.max(0, sec);
  const s  = Math.floor(sec);
  const m  = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function findTrackAtTime(tracks, time) {
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (time >= tracks[i].start_time) return tracks[i];
  }
  return tracks[0];
}
