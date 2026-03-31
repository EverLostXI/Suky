/**
 * audioEngine.js — Web Audio API 无缝播放引擎
 *
 * 核心策略（Gapless）：
 *   - 使用 AudioContext 的精确时间线调度多个 BufferSourceNode
 *   - 当前曲目播放时，提前 decode 下一首并 schedule 到精确结束时刻
 *   - seek 操作：清除全部 source，从新位置重新调度
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gainNode = null;

    this.albumData = null;
    this.currentTrackIndex = -1;

    // 已调度的 source 列表 [{source, trackIndex, startCtxTime, trackOffset}]
    this._scheduled = [];

    // 暂停时保存的专辑时间
    this._pausedAt = 0;
    this.isPlaying = false;

    // 已解码的 buffer 缓存
    this._buffers = {};

    // 回调
    this.onTimeUpdate = null;   // (albumTime, trackIndex) => void
    this.onTrackChange = null;  // (trackIndex) => void
    this.onEnded = null;        // () => void
    this.onPlaybackStateChange = null; // (isPlaying) => void

    this._rafId = null;
    this._trackEndTimer = null;
    this._playSeq = 0;
    this._lastMediaPositionSyncAt = 0;
    this._hasMediaSession =
      typeof navigator !== 'undefined' &&
      'mediaSession' in navigator &&
      typeof navigator.mediaSession?.setActionHandler === 'function';
    this._mediaSessionHandlers = null;
    this.mediaSessionEl = null;
    this._mediaHostUrl = null;
    this._syncingMediaElement = false;

    this._ensureMediaHost();
    this._setupMediaSession();
  }

  _setupMediaSession() {
    if (!this._hasMediaSession) return;

    if (!this._mediaSessionHandlers) {
      const runAction = (action, handler) => async details => {
        try {
          await handler(details);
        } catch (e) {
          console.error(`Media Session action failed: ${action}`, e);
        }
      };

      this._mediaSessionHandlers = {
        play: runAction('play', () => this.resume()),
        pause: runAction('pause', () => this.pause()),
        previoustrack: runAction('previoustrack', () => this.prevTrack()),
        nexttrack: runAction('nexttrack', () => this.nextTrack()),
        seekbackward: runAction('seekbackward', details =>
          this.seekBy(-(details?.seekOffset ?? 10), { autoplay: this.isPlaying })
        ),
        seekforward: runAction('seekforward', details =>
          this.seekBy(details?.seekOffset ?? 10, { autoplay: this.isPlaying })
        ),
        seekto: runAction('seekto', details => {
          if (typeof details?.seekTime !== 'number') return;
          return this.seekWithinCurrentTrack(details.seekTime, { autoplay: this.isPlaying });
        }),
        stop: runAction('stop', () => this.pause())
      };
    }

    const safeSetAction = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (e) {
        console.warn(`Media Session action unsupported or failed to bind: ${action}`, e);
      }
    };

    Object.entries(this._mediaSessionHandlers).forEach(([action, handler]) => {
      safeSetAction(action, null);
      safeSetAction(action, handler);
    });
  }

  _setPlaybackState(isPlaying) {
    const changed = this.isPlaying !== isPlaying;
    this.isPlaying = isPlaying;
    this._syncMediaSessionPlaybackState();
    if (changed) {
      this.onPlaybackStateChange?.(isPlaying);
    }
  }

  _clampAlbumTime(albumTime) {
    if (!this.albumData) return 0;
    return Math.max(0, Math.min(albumTime, this.albumData.total_duration));
  }

  _findTrackIndexByAlbumTime(albumTime) {
    if (!this.albumData?.tracks?.length) return -1;
    const clamped = this._clampAlbumTime(albumTime);
    const tracks = this.albumData.tracks;

    for (let i = 0; i < tracks.length; i++) {
      const end = tracks[i].start_time + tracks[i].duration;
      if (clamped < end || i === tracks.length - 1) return i;
    }
    return tracks.length - 1;
  }

  _getTrackByIndex(trackIndex = this.currentTrackIndex) {
    if (!this.albumData?.tracks?.length) return null;
    if (trackIndex < 0 || trackIndex >= this.albumData.tracks.length) return null;
    return this.albumData.tracks[trackIndex];
  }

  _getCurrentTrackTime(albumTime = this._getCurrentAlbumTime(), trackIndex = this.currentTrackIndex) {
    const track = this._getTrackByIndex(trackIndex);
    if (!track) return 0;
    return Math.max(0, Math.min(track.duration, albumTime - track.start_time));
  }

  _getArtworkItems() {
    if (!this.albumData?.cover_url) return undefined;

    let type;
    if (this.albumData.cover_url.endsWith('.png')) type = 'image/png';
    else if (this.albumData.cover_url.endsWith('.webp')) type = 'image/webp';
    else if (this.albumData.cover_url.endsWith('.gif')) type = 'image/gif';
    else type = 'image/jpeg';

    return [{ src: this.albumData.cover_url, type }];
  }

  _syncMediaSessionMetadata(trackIndex = this.currentTrackIndex) {
    if (!this._hasMediaSession || typeof MediaMetadata === 'undefined' || !this.albumData) return;
    this._setupMediaSession();

    const track = this._getTrackByIndex(trackIndex);
    if (!track) return;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || this.albumData.title || 'Unknown Track',
        artist: track.artist || this.albumData.artist || '',
        album: this.albumData.title || '',
        artwork: this._getArtworkItems()
      });
    } catch (_) { }
  }

  _syncMediaSessionPlaybackState() {
    if (!this._hasMediaSession) return;
    this._setupMediaSession();
    try {
      navigator.mediaSession.playbackState = !this.albumData
        ? 'none'
        : this.isPlaying
          ? 'playing'
          : 'paused';
    } catch (_) { }
  }

  _syncMediaSessionPositionState(albumTime = this._getCurrentAlbumTime(), force = false) {
    if (
      !this._hasMediaSession ||
      typeof navigator.mediaSession?.setPositionState !== 'function' ||
      !this.albumData
    ) return;

    const track = this._getTrackByIndex();
    if (!track?.duration) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && now - this._lastMediaPositionSyncAt < 250) return;
    this._lastMediaPositionSyncAt = now;

    try {
      navigator.mediaSession.setPositionState({
        duration: track.duration,
        playbackRate: 1,
        position: this._getCurrentTrackTime(albumTime)
      });
    } catch (_) { }
  }

  _clearMediaSession() {
    if (!this._hasMediaSession) return;
    this._setupMediaSession();
    this._lastMediaPositionSyncAt = 0;

    if (this.mediaSessionEl) {
      this._syncingMediaElement = true;
      try {
        this.mediaSessionEl.pause();
        this.mediaSessionEl.currentTime = 0;
      } catch (_) { }
      this._syncingMediaElement = false;
    }

    try {
      navigator.mediaSession.metadata = null;
    } catch (_) { }

    try {
      navigator.mediaSession.playbackState = 'none';
    } catch (_) { }

    if (typeof navigator.mediaSession?.setPositionState === 'function') {
      try {
        navigator.mediaSession.setPositionState();
      } catch (_) { }
    }
  }

  _updateCurrentTrackIndex(trackIndex, { notify = false } = {}) {
    if (trackIndex < 0) return;
    const changed = this.currentTrackIndex !== trackIndex;
    this.currentTrackIndex = trackIndex;
    this._syncMediaSessionMetadata(trackIndex);
    this._syncMediaSessionPositionState(undefined, true);
    if (changed || notify) {
      this.onTrackChange?.(trackIndex);
    }
  }

  /** 懒初始化 AudioContext（必须在用户手势后调用） */
  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gainNode = this.ctx.createGain();
      this.gainNode.connect(this.ctx.destination);
    }
  }

  _createSilentWavUrl() {
    if (this._mediaHostUrl) return this._mediaHostUrl;

    const sampleRate = 8000;
    const seconds = 10;
    const numSamples = sampleRate * seconds;
    const buffer = new ArrayBuffer(44 + numSamples);
    const view = new DataView(buffer);

    // WAV header
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);      // subchunk size
    view.setUint16(20, 1, true);       // PCM
    view.setUint16(22, 1, true);       // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true); // byte rate
    view.setUint16(32, 1, true);       // block align
    view.setUint16(34, 8, true);       // 8-bit
    writeStr(36, 'data');
    view.setUint32(40, numSamples, true);

    for (let i = 0; i < numSamples; i++) {
      view.setUint8(44 + i, 128);
    }

    this._mediaHostUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    return this._mediaHostUrl;
  }

  _ensureMediaHost() {
    if (this.mediaSessionEl || typeof Audio === 'undefined') return;

    const el = new Audio();
    el.loop = true;
    el.preload = 'auto';
    el.playsInline = true;
    el.volume = 1;
    el.src = this._createSilentWavUrl();

    el.addEventListener('play', () => {
      if (this._syncingMediaElement) return;
      if (!this.isPlaying && this.albumData?.tracks?.length) {
        void this.resume();
      }
    });

    el.addEventListener('pause', () => {
      if (this._syncingMediaElement) return;
      if (this.isPlaying) {
        void this.pause();
      }
    });

    this.mediaSessionEl = el;
  }

  async _syncMediaElementPlaybackState(shouldPlay) {
    if (!this.mediaSessionEl) return;

    this._syncingMediaElement = true;
    try {
      if (shouldPlay) {
        if (this.mediaSessionEl.paused) {
          await this.mediaSessionEl.play();
        }
      } else if (!this.mediaSessionEl.paused) {
        this.mediaSessionEl.pause();
      }
    } catch (e) {
      console.warn('Media host sync failed', e);
    } finally {
      this._syncingMediaElement = false;
    }
  }

  /** 加载专辑数据（不自动开始播放） */
  loadAlbum(albumData) {
    this._stop();
    this.albumData = albumData;
    this.currentTrackIndex = -1;
    this._pausedAt = 0;
    this._buffers = {};
    this._setupMediaSession();
    this._setPlaybackState(false);
    this._clearMediaSession();
  }

  /** fetch + decode 某首曲目的 buffer（带缓存） */
  async _fetchBuffer(trackIndex) {
    const url = this.albumData.tracks[trackIndex].file_url;
    if (this._buffers[url]) return this._buffers[url];
    const res = await fetch(url);
    const ab = await res.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(ab);
    this._buffers[url] = buf;
    return buf;
  }

  /**
   * 从指定专辑时间开始播放
   * @param {number} albumTime
   */
  async seekAndPlay(albumTime) {
    const seq = ++this._playSeq;
    if (!this.albumData?.tracks?.length) return;

    const clampedAlbumTime = this._clampAlbumTime(albumTime);
    this._ensureCtx();
    this._stop();
    this._pausedAt = clampedAlbumTime;

    const tracks = this.albumData.tracks;
    const ti = this._findTrackIndexByAlbumTime(clampedAlbumTime);
    const offset = clampedAlbumTime - tracks[ti].start_time;

    try {
      await this._scheduleFrom(ti, offset, this.ctx.currentTime, seq);
      if (this._playSeq !== seq) {
        this._stop();
        return;
      }
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      if (this._playSeq !== seq) {
        this._stop();
        return;
      }
      await this._syncMediaElementPlaybackState(true);
      if (this._playSeq !== seq) return;
      this._setPlaybackState(true);
      this._syncMediaSessionPositionState(clampedAlbumTime, true);
      this._startRAF();
    } catch (e) {
      if (this._playSeq === seq) {
        this._stop();
        this._setPlaybackState(false);
        this._syncMediaSessionPositionState(clampedAlbumTime, true);
      }
      throw e;
    }
  }

  /** 从 trackIndex + trackOffset 开始，向后链式调度 */
  async _scheduleFrom(trackIndex, trackOffset, ctxStartTime, seq) {
    const tracks = this.albumData.tracks;
    let when = ctxStartTime;
    let ti = trackIndex;
    let offset = trackOffset;

    // 调度当前曲目 + 预加载下一首（只提前调度 2 首以控制内存）
    const MAX_AHEAD = 2;
    for (let i = 0; i < MAX_AHEAD && ti < tracks.length; i++) {
      const buf = await this._fetchBuffer(ti);
      if (seq !== undefined && this._playSeq !== seq) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gainNode);

      const playDuration = buf.duration - offset;
      src.start(when, offset);

      const entry = { source: src, trackIndex: ti, startCtxTime: when, trackOffset: offset };
      this._scheduled.push(entry);

      // 当这首结束时，调度再下一首
      const tiCapture = ti;
      const whenCapture = when + playDuration;
      src.onended = () => this._onSourceEnded(tiCapture, whenCapture);

      when += playDuration;
      ti++;
      offset = 0;
    }

    this._updateCurrentTrackIndex(trackIndex, { notify: true });
  }

  /** 某首 source 播放结束时的回调 */
  async _onSourceEnded(endedTrackIndex, nextStartCtxTime) {
    if (!this.isPlaying) return;

    const nextTrackIndex = endedTrackIndex + 1;
    const tracks = this.albumData.tracks;

    if (nextTrackIndex >= tracks.length) {
      // 专辑结束
      this._setPlaybackState(false);
      this._pausedAt = this.albumData.total_duration;
      this._stopRAF();
      this._syncMediaSessionPositionState(this._pausedAt, true);
      this.onTimeUpdate?.(this._pausedAt, this.currentTrackIndex);
      this.onEnded?.();
      return;
    }

    // 检查是否已经调度过这首
    const alreadyScheduled = this._scheduled.some(e => e.trackIndex === nextTrackIndex);
    if (alreadyScheduled) {
      // 更新 currentTrackIndex
      this._updateCurrentTrackIndex(nextTrackIndex, { notify: true });
      // 尝试预加载 +1
      const lookAhead = nextTrackIndex + 1;
      if (lookAhead < tracks.length) {
        const alreadyNext = this._scheduled.some(e => e.trackIndex === lookAhead);
        if (!alreadyNext) {
          // 调度 +1
          const prevEntry = this._scheduled.find(e => e.trackIndex === nextTrackIndex);
          if (prevEntry) {
            const buf = prevEntry.source.buffer;
            const startNext = prevEntry.startCtxTime + buf.duration - prevEntry.trackOffset;
            await this._scheduleOneMore(lookAhead, startNext);
          }
        }
      }
    }
  }

  async _scheduleOneMore(trackIndex, ctxWhen) {
    if (trackIndex >= this.albumData.tracks.length) return;
    const buf = await this._fetchBuffer(trackIndex);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gainNode);
    src.start(ctxWhen, 0);
    const entry = { source: src, trackIndex, startCtxTime: ctxWhen, trackOffset: 0 };
    this._scheduled.push(entry);
    src.onended = () => this._onSourceEnded(trackIndex, ctxWhen + buf.duration);
  }

  /** 停止所有已调度的 source */
  _stop() {
    this._scheduled.forEach(({ source }) => {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch (_) { }
    });
    this._scheduled = [];
    this._stopRAF();
  }

  /** 暂停 */
  async pause() {
    const seq = ++this._playSeq;
    if (!this.isPlaying) return;
    this._pausedAt = this._getCurrentAlbumTime();
    this._stopRAF();
    this._setPlaybackState(false);
    this.onTimeUpdate?.(this._pausedAt, this.currentTrackIndex);
    this._syncMediaSessionPositionState(this._pausedAt, true);
    await this._syncMediaElementPlaybackState(false);
    if (this.ctx?.state === 'running') {
      try {
        await this.ctx.suspend();
      } catch (_) { }
      if (this._playSeq !== seq && this.ctx.state === 'suspended' && this.isPlaying) {
        try {
          await this.ctx.resume();
        } catch (_) { }
      }
    }
  }

  /** 继续播放 */
  async resume() {
    const seq = ++this._playSeq;
    if (this.isPlaying || !this.albumData?.tracks?.length) return;

    // 专辑播放到末尾后重新从头开始：
    // 仅重置 _pausedAt 不够——_scheduled 里还留着已结束的 sources，
    // 会触发 fast path（ctx 仍 running），导致 RAF 空转、currentTrackIndex
    // 和 MediaSession 停留在末尾状态。
    // 调用 _stop() 清空 _scheduled，让后续逻辑走 seekAndPlay(0)，
    // 由它统一更新 currentTrackIndex / MediaSession metadata / position state。
    if (this._pausedAt >= this.albumData.total_duration) {
      this._pausedAt = 0;
      this._stop();
    }

    if (this.ctx && this._scheduled.length) {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      if (this._playSeq !== seq) return;
      await this._syncMediaElementPlaybackState(true);
      if (this._playSeq !== seq) return;
      this._setPlaybackState(true);
      this._syncMediaSessionPositionState(this._pausedAt, true);
      this._startRAF();
      return;
    }
    await this.seekAndPlay(this._pausedAt);
  }

  /** 跳到下一首 */
  async nextTrack() {
    if (!this.albumData?.tracks?.length) return;
    const autoplay = this.isPlaying;
    if (this.currentTrackIndex < 0) {
      await this.seekToAlbumTime(this.albumData.tracks[0].start_time, { autoplay });
      return;
    }
    const next = this.currentTrackIndex + 1;
    if (next >= this.albumData.tracks.length) return;
    const albumTime = this.albumData.tracks[next].start_time;
    await this.seekToAlbumTime(albumTime, { autoplay });
  }

  /** 跳到上一首（3秒内返回上一首，否则本首重头） */
  async prevTrack() {
    if (!this.albumData?.tracks?.length) return;
    const autoplay = this.isPlaying;
    if (this.currentTrackIndex <= 0) {
      await this.seekToAlbumTime(this.albumData.tracks[0].start_time, { autoplay });
      return;
    }
    const trackTime = this._getCurrentAlbumTime() - this.albumData.tracks[this.currentTrackIndex].start_time;
    if (trackTime > 3 || this.currentTrackIndex === 0) {
      await this.seekToAlbumTime(this.albumData.tracks[this.currentTrackIndex].start_time, { autoplay });
    } else {
      const prev = this.currentTrackIndex - 1;
      await this.seekToAlbumTime(this.albumData.tracks[prev].start_time, { autoplay });
    }
  }

  setVolume(v) {
    if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(1, v));
  }

  async seekToAlbumTime(albumTime, { autoplay = this.isPlaying } = {}) {
    if (!this.albumData?.tracks?.length) return;

    const clampedAlbumTime = this._clampAlbumTime(albumTime);
    if (autoplay) {
      await this.seekAndPlay(clampedAlbumTime);
      return;
    }

    const seq = ++this._playSeq;
    this._ensureCtx();
    if (this.ctx.state === 'running') {
      try {
        await this.ctx.suspend();
      } catch (_) { }
    }
    if (this._playSeq !== seq) return;

    this._stop();
    this._pausedAt = clampedAlbumTime;
    const trackIndex = this._findTrackIndexByAlbumTime(clampedAlbumTime);
    const offset = clampedAlbumTime - this.albumData.tracks[trackIndex].start_time;

    try {
      await this._scheduleFrom(trackIndex, offset, this.ctx.currentTime, seq);
      if (this._playSeq !== seq) {
        this._stop();
        return;
      }
      await this._syncMediaElementPlaybackState(false);
      this._setPlaybackState(false);
      this.onTimeUpdate?.(clampedAlbumTime, trackIndex);
      this._syncMediaSessionPositionState(clampedAlbumTime, true);
    } catch (e) {
      if (this._playSeq === seq) {
        this._stop();
        this._setPlaybackState(false);
        this._syncMediaSessionPositionState(clampedAlbumTime, true);
      }
      throw e;
    }
  }

  async seekWithinCurrentTrack(trackTime, { autoplay = this.isPlaying } = {}) {
    const track = this._getTrackByIndex();
    if (!track) return;

    const clampedTrackTime = Math.max(0, Math.min(track.duration, trackTime));
    await this.seekToAlbumTime(track.start_time + clampedTrackTime, { autoplay });
  }

  async seekBy(deltaSeconds, { autoplay = this.isPlaying } = {}) {
    const track = this._getTrackByIndex();
    if (!track) return;

    await this.seekWithinCurrentTrack(this._getCurrentTrackTime() + deltaSeconds, { autoplay });
  }

  /** 计算当前专辑时间 */
  _getCurrentAlbumTime() {
    if (!this.albumData || this.currentTrackIndex < 0) return 0;
    if (!this.isPlaying) return this._pausedAt;

    // 找到当前正在播放的 source
    const now = this.ctx.currentTime;
    // 从已调度的 source 中找出正在播放的那个（startCtxTime <= now）
    let entry = null;
    for (let i = this._scheduled.length - 1; i >= 0; i--) {
      if (this._scheduled[i].startCtxTime <= now) {
        entry = this._scheduled[i];
        break;
      }
    }
    if (!entry) return this._pausedAt;

    const track = this.albumData.tracks[entry.trackIndex];
    const elapsed = now - entry.startCtxTime + entry.trackOffset;
    return Math.min(track.start_time + elapsed, this.albumData.total_duration);
  }

  /** requestAnimationFrame 时间更新循环 */
  _startRAF() {
    const tick = () => {
      if (!this.isPlaying) return;
      const t = this._getCurrentAlbumTime();
      // 同步 currentTrackIndex
      const tracks = this.albumData.tracks;
      for (let i = tracks.length - 1; i >= 0; i--) {
        if (t >= tracks[i].start_time) {
          if (this.currentTrackIndex !== i) {
            this._updateCurrentTrackIndex(i, { notify: true });
          }
          break;
        }
      }
      this.onTimeUpdate?.(t, this.currentTrackIndex);
      this._syncMediaSessionPositionState(t);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopRAF() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** 当前是否有专辑加载 */
  get hasAlbum() { return !!this.albumData; }

  get currentAlbumTime() { return this._getCurrentAlbumTime(); }
}

export const audioEngine = new AudioEngine();
