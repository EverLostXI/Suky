/**
 * main.js — 初始化入口
 */
import state from './core/state.js';
import { loadAlbumsList } from './core/dataLoader.js';
import {
  assertLocalLibrarySupport,
  chooseMusicRoot,
  forgetMusicRoot,
  initVirtualDataWorker,
  loadStoredMusicRoot,
  queryMusicRootPermission,
  requestMusicRootPermission,
  scanMusicRoot
} from './core/localLibrary.js';
import { audioEngine } from './core/audioEngine.js';
import {
  renderCoverFlow,
  initCoverFlowControls,
  initProgressBar,
  initCdDrag,
  initPlaybackControls,
  initHoverZones,
  initSettings,
  initSearch,
  updateProgressBar,
  updatePlayPauseBtn,
  isCdDragging
} from './ui/components.js';
import { createStartupOverlay } from './ui/startupOverlay.js';

const startupOverlay = createStartupOverlay();
let currentRootHandle = null;
let rebuildInFlight = false;

async function init() {
  bindLibrarySettingsActions();

  await prepareLocalLibrary();

  const albums = await loadAlbumsList();
  state.set('albums', albums);

  startupOverlay.hide();

  renderCoverFlow();

  const startupInfo = document.querySelector('.is-startup-info');
  let startupCleanupDone = false;
  const finishStartup = () => {
    if (startupCleanupDone) return;
    startupCleanupDone = true;
    document.body.classList.remove('is-startup');
    startupInfo?.classList.remove('is-startup-info');
  };

  if (startupInfo) {
    startupInfo.addEventListener('animationend', e => {
      if (e.animationName === 'infoEmergence') {
        finishStartup();
      }
    }, { once: true });

    setTimeout(finishStartup, 2400);
  } else {
    setTimeout(finishStartup, 1600);
  }

  initCoverFlowControls();
  initProgressBar();
  initCdDrag();
  initPlaybackControls();
  initHoverZones();
  initSettings();
  initSearch();

  audioEngine.onPlaybackStateChange = isPlaying => {
    state.set('isPlaying', isPlaying);
    updatePlayPauseBtn();
  };

  let lastSaveTime = 0;
  audioEngine.onTimeUpdate = (albumTime, trackIndex) => {
    state.set('currentAlbumTime', albumTime);
    state.set('currentTrackIndex', trackIndex);
    if (!isCdDragging()) {
      updateProgressBar(albumTime);
    }

    const now = Date.now();
    if (now - lastSaveTime > 3000) {
      lastSaveTime = now;
      const albumId = state.currentAlbum?.id;
      if (albumId) {
        localStorage.setItem(`playersky_progress_${albumId}`, albumTime);
      }
    }
  };

  let trackInfoTimeout;
  audioEngine.onTrackChange = trackIndex => {
    state.set('currentTrackIndex', trackIndex);

    const currentTime = audioEngine.currentAlbumTime || state.currentAlbumTime || 0;
    updateProgressBar(currentTime);

    const trackInfo = document.querySelector('.track-info');
    if (trackInfo) {
      trackInfo.classList.add('force-show');
      clearTimeout(trackInfoTimeout);
      trackInfoTimeout = setTimeout(() => {
        trackInfo.classList.remove('force-show');
      }, 3000);
    }
  };

  audioEngine.onEnded = () => {
    state.set('isPlaying', false);
    updatePlayPauseBtn();
  };

  audioEngine.setVolume(state.volume);

  console.log('Suky initialized.');
}

async function prepareLocalLibrary() {
  assertLocalLibrarySupport();

  startupOverlay.showScanning(0, 0, '正在注册虚拟数据 Service Worker。');
  await initVirtualDataWorker();

  currentRootHandle = await resolveMusicRootHandle();

  startupOverlay.showScanning(0, 0, '正在扫描音乐目录并写入 .suky 元数据。');
  await scanMusicRoot(currentRootHandle, {
    onProgress(done, total) {
      startupOverlay.showScanning(done, total, '正在扫描音乐目录并写入 .suky 元数据。');
    }
  });
}

async function resolveMusicRootHandle() {
  const storedHandle = await loadStoredMusicRoot();
  if (!storedHandle) {
    return promptForNewMusicRoot();
  }

  const permission = await queryMusicRootPermission(storedHandle);
  if (permission === 'granted') {
    return storedHandle;
  }

  if (permission === 'prompt') {
    return promptForStoredHandlePermission(storedHandle);
  }

  return promptForNewMusicRoot();
}

async function promptForNewMusicRoot() {
  return new Promise((resolve, reject) => {
    let busy = false;

    const pickDirectory = async () => {
      if (busy) return;
      busy = true;

      try {
        const handle = await chooseMusicRoot();
        resolve(handle);
      } catch (error) {
        if (error?.name === 'AbortError') {
          busy = false;
          startupOverlay.showWelcome(pickDirectory);
          return;
        }
        reject(error);
      }
    };

    startupOverlay.showWelcome(pickDirectory);
  });
}

async function promptForStoredHandlePermission(handle) {
  return new Promise((resolve, reject) => {
    let busy = false;

    const chooseAnother = async () => {
      if (busy) return;
      busy = true;

      try {
        const newHandle = await chooseMusicRoot();
        resolve(newHandle);
      } catch (error) {
        if (error?.name === 'AbortError') {
          busy = false;
          startupOverlay.showPermissionRequest(continueAccess, chooseAnother);
          return;
        }
        reject(error);
      }
    };

    const continueAccess = async () => {
      if (busy) return;
      busy = true;

      try {
        const permission = await requestMusicRootPermission(handle);
        if (permission === 'granted') {
          resolve(handle);
          return;
        }

        busy = false;
        startupOverlay.showPermissionRequest(continueAccess, chooseAnother);
      } catch (error) {
        reject(error);
      }
    };

    startupOverlay.showPermissionRequest(continueAccess, chooseAnother);
  });
}

function bindLibrarySettingsActions() {
  const rebuildBtn = document.getElementById('rebuild-library-btn');
  const changeRootBtn = document.getElementById('change-root-btn');

  rebuildBtn?.addEventListener('click', async () => {
    if (!currentRootHandle || rebuildInFlight) return;

    rebuildInFlight = true;
    startupOverlay.showScanning(0, 0, '正在整库重建媒体库并刷新封面缓存。');

    try {
      await scanMusicRoot(currentRootHandle, {
        rebuild: true,
        onProgress(done, total) {
          startupOverlay.showScanning(done, total, '正在整库重建媒体库并刷新封面缓存。');
        }
      });
      window.location.reload();
    } catch (error) {
      rebuildInFlight = false;
      startupOverlay.showError(error, {
        onRetry: () => window.location.reload(),
        onChooseDirectory: handleChangeRoot
      });
    }
  });

  changeRootBtn?.addEventListener('click', handleChangeRoot);
}

async function handleChangeRoot() {
  await forgetMusicRoot();
  window.location.reload();
}

init().catch(error => {
  console.error(error);
  startupOverlay.showError(error, {
    onRetry: () => window.location.reload(),
    onChooseDirectory: async () => {
      try {
        await forgetMusicRoot();
      } catch (_) {
        // Ignore cleanup failures while recovering from init errors.
      }
      window.location.reload();
    }
  });
});
