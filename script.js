/**
 * Cinestream - High-Performance Adaptive Media Player Engine
 * Core Logic (script.js)
 */

let plyrPlayer = null;
let hlsInstance = null;
let dashInstance = null;
let errorRetries = 0;

// DOM Elements
const videoElement = document.getElementById('cinestream-player');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const diagEngine = document.getElementById('diag-engine');
const diagFormat = document.getElementById('diag-format');
const diagState = document.getElementById('diag-state');
const diagResolution = document.getElementById('diag-resolution');
const diagBuffer = document.getElementById('diag-buffer');
const streamForm = document.getElementById('stream-form');
const streamInput = document.getElementById('stream-url');

// LocalStorage Keys (to clean up)
const HISTORY_KEY = 'cinestream_history';

// Clear any local browser storage pipelines previously associated with the old history cache data
try {
  localStorage.removeItem(HISTORY_KEY);
  localStorage.clear();
  console.log('Zero-footprint initialization: Local history storage cache pipelines cleared.');
} catch (e) {
  console.warn('Could not clear local storage pipelines:', e);
}

/**
 * Clean up existing player streaming adapters (Hls.js / Dash.js)
 * and reset the native video element to prevent memory leaks.
 */
function cleanupEngines() {
  console.log('Cleaning up player engines...');
  
  // Reset Diagnostic Panel
  diagResolution.innerText = '-';
  diagBuffer.innerHTML = '<span class="highlight">0.00</span>s';

  // 1. Destroy Hls.js
  if (hlsInstance) {
    try {
      hlsInstance.destroy();
    } catch (e) {
      console.warn('Error destroying Hls instance:', e);
    }
    hlsInstance = null;
  }

  // 2. Destroy Dash.js
  if (dashInstance) {
    try {
      dashInstance.destroy();
    } catch (e) {
      console.warn('Error destroying Dash instance:', e);
    }
    dashInstance = null;
  }

  // 3. Reset native video element to free memory
  if (videoElement) {
    try {
      videoElement.pause();
      while (videoElement.firstChild) {
        videoElement.removeChild(videoElement.firstChild);
      }
      videoElement.removeAttribute('src');
      videoElement.load();
    } catch (e) {
      console.warn('Error resetting native video element:', e);
    }
  }
}

/**
 * Determine the stream protocol/type using flexible regex matching
 * to support heavily parameterized CDN and cryptographic redirect URLs.
 */
function detectStreamType(url) {
  if (!url) return 'progressive';
  
  // Extract file type indicators from the URL string, ignoring parameters and hashes
  if (/m3u8/i.test(url)) {
    return 'hls';
  }
  if (/mpd/i.test(url)) {
    return 'dash';
  }
  if (/mp4/i.test(url)) {
    return 'mp4';
  }
  if (/webm/i.test(url)) {
    return 'webm';
  }
  
  // Default fallback if no obvious keywords are detected
  return 'progressive';
}

/**
 * Update the diagnostic State of the player
 */
function updateState(state) {
  if (!diagState || !statusDot || !statusText) return;
  
  diagState.innerText = state;
  
  // Update status badge UI
  if (state === 'Playing') {
    statusDot.className = 'status-dot active';
    statusText.innerText = 'ENGINE: PLAYING';
  } else if (state === 'Buffering') {
    statusDot.className = 'status-dot buffering';
    statusText.innerText = 'ENGINE: BUFFERING';
  } else if (state === 'Paused') {
    statusDot.className = 'status-dot';
    statusText.innerText = 'ENGINE: PAUSED';
  } else if (state === 'Seeking') {
    statusDot.className = 'status-dot buffering';
    statusText.innerText = 'ENGINE: SEEKING';
  } else if (state === 'Completed') {
    statusDot.className = 'status-dot';
    statusText.innerText = 'ENGINE: COMPLETED';
  } else if (state === 'Error') {
    statusDot.className = 'status-dot error';
    statusText.innerText = 'ENGINE: ERROR';
  } else {
    statusDot.className = 'status-dot';
    statusText.innerText = 'ENGINE: READY';
  }
}

/**
 * Calculate buffer stats at the current playhead
 */
function updateBufferStat() {
  if (!videoElement) return;
  
  const buffered = videoElement.buffered;
  const currentTime = videoElement.currentTime;
  let bufferLen = 0;
  
  for (let i = 0; i < buffered.length; i++) {
    if (currentTime >= buffered.start(i) && currentTime <= buffered.end(i)) {
      bufferLen = buffered.end(i) - currentTime;
      break;
    }
  }
  
  if (diagBuffer) {
    diagBuffer.innerHTML = `<span class="highlight">${bufferLen.toFixed(2)}</span>s`;
  }
}

/**
 * Setup Event Diagnostics for Hls.js
 */
function setupHlsDiagnostics(hls, url) {
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    updateState('Playing');
    errorRetries = 0; // Reset error retries upon successful load
    videoElement.play().catch(err => {
      console.log('Autoplay deferred pending browser interaction:', err);
    });
  });

  hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
    try {
      const level = hls.levels[data.level];
      if (level) {
        diagResolution.innerText = `${level.width}x${level.height} (Auto)`;
      }
    } catch (e) {
      console.warn('Error reading HLS quality level details:', e);
    }
  });

  hls.on(Hls.Events.ERROR, (event, data) => {
    console.warn('HLS.js diagnostic warning/error:', data);
    if (data.fatal) {
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          console.warn('Fatal HLS network error, attempting segment recovery...');
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          console.warn('Fatal HLS media error, attempting error recovery...');
          hls.recoverMediaError();
          break;
        default:
          console.error('Fatal unrecoverable HLS error. Intercepting and refreshing source bindings...');
          if (errorRetries < 2) {
            errorRetries++;
            setTimeout(() => refreshSourceBindings(url), 500);
          } else {
            updateState('Error');
            statusDot.className = 'status-dot error';
            statusText.innerText = 'ENGINE: HLS CRITICAL';
          }
          break;
      }
    }
  });
}

/**
 * Setup Event Diagnostics for Dash.js
 */
function setupDashDiagnostics(dash, url) {
  dash.on(dashjs.MediaPlayer.events.PLAYBACK_METADATA_LOADED, () => {
    updateState('Playing');
    errorRetries = 0; // Reset error retries upon successful load
  });

  dash.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, (e) => {
    if (e.mediaType === 'video') {
      try {
        const bitrates = dash.getBitrateInfoListFor('video');
        const activeQualityIndex = dash.getQualityFor('video');
        if (bitrates && bitrates[activeQualityIndex]) {
          const info = bitrates[activeQualityIndex];
          diagResolution.innerText = `${info.width}x${info.height} (${(info.bitrate / 1000000).toFixed(2)} Mbps)`;
        }
      } catch (err) {
        console.warn('Could not read Dash quality metrics:', err);
      }
    }
  });

  dash.on(dashjs.MediaPlayer.events.ERROR, (e) => {
    console.error('Dash.js diagnostic warning/error:', e);
    if (errorRetries < 2) {
      errorRetries++;
      console.warn('DASH error intercepted. Attempting to refresh source bindings...');
      setTimeout(() => refreshSourceBindings(url), 500);
    } else {
      updateState('Error');
      statusDot.className = 'status-dot error';
      statusText.innerText = 'ENGINE: DASH ERROR';
    }
  });
}

/**
 * Dynamically refresh source bindings during momentary Media Errors
 * instead of halting the playback decoder thread.
 */
function refreshSourceBindings(url) {
  console.log(`Refreshing engine source bindings for URL: ${url}`);
  
  const lastTime = videoElement ? videoElement.currentTime : 0;
  const streamType = detectStreamType(url);
  
  if (streamType === 'hls' && hlsInstance) {
    try {
      hlsInstance.recoverMediaError();
    } catch (e) {
      console.warn('HLS recovery retry failed, re-attaching sources...', e);
      hlsInstance.detachMedia();
      hlsInstance.attachMedia(videoElement);
      hlsInstance.loadSource(url);
    }
  } else if (streamType === 'dash' && dashInstance) {
    try {
      dashInstance.reset();
      dashInstance.initialize(videoElement, url, true);
    } catch (e) {
      console.warn('Dash recovery retry failed, re-initializing...', e);
    }
  } else {
    if (videoElement) {
      videoElement.load();
      videoElement.play().catch(err => console.log('Autoplay deferred:', err));
    }
  }

  // Restore current playhead time after refresh
  if (lastTime > 0 && videoElement) {
    videoElement.currentTime = lastTime;
  }
}

/**
 * Primary Core Loader: Sets up the dynamic adapters and starts playback
 */
function loadStream(url) {
  if (!url || typeof url !== 'string') return;
  
  // Pre-process: Clean whitespace and resolve missing protocol schemes
  url = url.trim().replace(/\s+/g, '');
  if (url === '') return;

  if (!/^https?:\/\//i.test(url)) {
    if (/^[a-z0-9]+([\-\.]{1}[a-z0-9]+)*\.[a-z]{2,5}/i.test(url)) {
      url = 'https://' + url;
    } else {
      alert('Invalid protocol. Stream must be hosted on HTTP or HTTPS.');
      return;
    }
  }

  console.log(`Loading stream endpoint: ${url}`);
  errorRetries = 0; // Reset retries for new load

  // 1. Clear out active engines and resets state
  cleanupEngines();

  // 2. Detect format and route natively
  const streamType = detectStreamType(url);
  diagFormat.innerText = streamType === 'progressive' ? 'DIRECT FEED' : streamType.toUpperCase();

  if (streamType === 'hls') {
    diagEngine.innerText = 'HLS.js Core';
    
    if (Hls.isSupported()) {
      hlsInstance = new Hls({
        maxMaxBufferLength: 30,
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 60
      });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(videoElement);
      setupHlsDiagnostics(hlsInstance, url);
    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari Native compatibility fallback
      diagEngine.innerText = 'Safari Native';
      videoElement.src = url;
      videoElement.load();
      videoElement.play().catch(err => console.log('Autoplay deferred:', err));
    } else {
      alert('Your browser does not support HLS streaming manifests (.m3u8).');
      diagEngine.innerText = 'Unsupported';
    }
    
  } else if (streamType === 'dash') {
    diagEngine.innerText = 'Dash.js Core';
    
    if (typeof dashjs !== 'undefined') {
      try {
        dashInstance = dashjs.MediaPlayer().create();
        dashInstance.initialize(videoElement, url, true);
        setupDashDiagnostics(dashInstance, url);
      } catch (err) {
        console.error('Error instantiating DASH client:', err);
        alert('Failed to initialize the MPEG-DASH media engine.');
      }
    } else {
      alert('DASH decoder library is not available in the head script tags.');
      diagEngine.innerText = 'Unavailable';
    }
    
  } else {
    // Direct Progressive feeds (MP4, WebM, parameterized CDN paths)
    diagEngine.innerText = 'HTML5 Native';
    videoElement.src = url;
    videoElement.load();
    videoElement.play().catch(err => console.log('Autoplay deferred:', err));
  }
}

/**
 * Plyr Wrapper initialization
 */
function initPlyr() {
  if (!videoElement) return;
  
  plyrPlayer = new Plyr(videoElement, {
    controls: [
      'play-large', 'play', 'progress', 'current-time', 'duration',
      'mute', 'volume', 'settings', 'pip', 'airplay', 'fullscreen'
    ],
    tooltips: { controls: true, seek: true },
    keyboard: { focused: true, global: true },
    title: 'Cinestream Viewer'
  });

  // Media Event Listeners for diagnostic readout updates
  videoElement.addEventListener('playing', () => updateState('Playing'));
  videoElement.addEventListener('pause', () => updateState('Paused'));
  videoElement.addEventListener('waiting', () => updateState('Buffering'));
  videoElement.addEventListener('seeking', () => updateState('Seeking'));
  videoElement.addEventListener('seeked', () => updateState('Playing'));
  videoElement.addEventListener('ended', () => updateState('Completed'));
  
  videoElement.addEventListener('resize', () => {
    if (videoElement.videoWidth && videoElement.videoHeight) {
      const currentRes = diagResolution.innerText;
      if (!currentRes.includes('Mbps')) {
        diagResolution.innerText = `${videoElement.videoWidth}x${videoElement.videoHeight}`;
      }
    }
  });

  // Intercept native media errors and dynamically refresh bindings
  videoElement.addEventListener('error', (e) => {
    console.error('Native HTML5 video error event intercepted:', e);
    if (errorRetries < 2) {
      errorRetries++;
      console.warn(`Attempting source binding refresh (retry ${errorRetries}/2)...`);
      const url = streamInput.value.trim();
      if (url) {
        setTimeout(() => refreshSourceBindings(url), 500);
      }
    } else {
      updateState('Error');
      diagEngine.innerText = 'Media Error';
      statusDot.className = 'status-dot error';
      statusText.innerText = 'ENGINE: ERROR';
    }
  });
}

// App Listeners setup
streamForm.addEventListener('submit', (e) => {
  e.preventDefault();
  loadStream(streamInput.value);
});

// App Start Initialization
document.addEventListener('DOMContentLoaded', () => {
  initPlyr();
  
  // Set up repeating buffer monitor
  setInterval(updateBufferStat, 300);
});
