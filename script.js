/**
 * Cinestream - High-Performance Adaptive Media Player Engine
 * Core Logic (script.js)
 */

let plyrPlayer = null;
let hlsInstance = null;
let dashInstance = null;

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
const presetButtons = document.querySelectorAll('.btn-preset');
const historyList = document.getElementById('history-list');
const btnClearHistory = document.getElementById('btn-clear-history');

// LocalStorage Keys
const HISTORY_KEY = 'cinestream_history';

/**
 * Clean up existing player streaming adapters (Hls.js / Dash.js)
 * and reset the native video element to prevent memory leaks.
 */
function cleanupEngines() {
  // Mute logs/activity
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
      // Remove all source elements
      while (videoElement.firstChild) {
        videoElement.removeChild(videoElement.firstChild);
      }
      // Detach src
      videoElement.removeAttribute('src');
      videoElement.load();
    } catch (e) {
      console.warn('Error resetting native video element:', e);
    }
  }
}

/**
 * Determine the stream protocol/type from the URL structure
 */
function detectStreamType(url) {
  if (!url) return 'progressive';
  
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    
    if (pathname.endsWith('.m3u8') || url.includes('.m3u8')) {
      return 'hls';
    }
    if (pathname.endsWith('.mpd') || url.includes('.mpd')) {
      return 'dash';
    }
    if (pathname.endsWith('.mp4') || url.includes('.mp4')) {
      return 'mp4';
    }
    if (pathname.endsWith('.webm') || url.includes('.webm')) {
      return 'webm';
    }
  } catch (e) {
    // Return progressive as a fallback if URL construction fails
  }
  
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
function setupHlsDiagnostics(hls) {
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    updateState('Playing');
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
          console.warn('Fatal HLS network error, attempting recovery...');
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          console.warn('Fatal HLS media error, attempting recovery...');
          hls.recoverMediaError();
          break;
        default:
          console.error('Fatal unrecoverable HLS error. Re-initializing engine...');
          updateState('Error');
          statusDot.className = 'status-dot error';
          statusText.innerText = 'ENGINE: HLS CRITICAL';
          break;
      }
    }
  });
}

/**
 * Setup Event Diagnostics for Dash.js
 */
function setupDashDiagnostics(dash) {
  dash.on(dashjs.MediaPlayer.events.PLAYBACK_METADATA_LOADED, () => {
    updateState('Playing');
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
    updateState('Error');
    statusDot.className = 'status-dot error';
    statusText.innerText = 'ENGINE: DASH ERROR';
  });
}

/**
 * Primary Core Loader: Sets up the dynamic adapters and starts playback
 */
function loadStream(url) {
  if (!url || typeof url !== 'string') return;
  url = url.trim();
  if (url === '') return;

  console.log(`Loading stream endpoint: ${url}`);

  // Highlight active preset button if applicable
  presetButtons.forEach(btn => {
    if (btn.getAttribute('data-url') === url) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // 1. Clear out active engines and resets state
  cleanupEngines();

  // 2. Validate URL structure
  try {
    const validator = new URL(url);
    if (validator.protocol !== 'http:' && validator.protocol !== 'https:') {
      alert('Invalid protocol. Stream must be hosted on HTTP or HTTPS.');
      return;
    }
  } catch (err) {
    alert('Please enter a valid absolute media stream URL.');
    return;
  }

  // 3. Detect and route
  const streamType = detectStreamType(url);
  diagFormat.innerText = streamType === 'progressive' ? 'MP4 / WEBM' : streamType.toUpperCase();

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
      setupHlsDiagnostics(hlsInstance);
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
        setupDashDiagnostics(dashInstance);
      } catch (err) {
        console.error('Error instantiating DASH client:', err);
        alert('Failed to initialize the MPEG-DASH media engine.');
      }
    } else {
      alert('DASH decoder library is not available in the head script tags.');
      diagEngine.innerText = 'Unavailable';
    }
    
  } else {
    // Direct Progressive feeds (MP4, WebM)
    diagEngine.innerText = 'HTML5 Native';
    videoElement.src = url;
    videoElement.load();
    videoElement.play().catch(err => console.log('Autoplay deferred:', err));
  }

  // 4. Save to cache history
  addToHistory(url);
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
      // Avoid overwriting HLS/DASH detailed text if already set with bitrate
      const currentRes = diagResolution.innerText;
      if (!currentRes.includes('Mbps')) {
        diagResolution.innerText = `${videoElement.videoWidth}x${videoElement.videoHeight}`;
      }
    }
  });

  videoElement.addEventListener('error', (e) => {
    updateState('Error');
    diagEngine.innerText = 'Media Error';
    console.error('HTML5 video media error:', e);
  });
}

/**
 * Cache History log handlers
 */
function getHistory() {
  try {
    const list = localStorage.getItem(HISTORY_KEY);
    return list ? JSON.parse(list) : [];
  } catch (e) {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch (e) {
    // Fail silently if storage quota exceeded
  }
}

function addToHistory(url) {
  let list = getHistory();
  // Filter out duplicate url if already exists
  list = list.filter(item => item.url !== url);
  // Add to top of array
  list.unshift({ url: url, timestamp: Date.now() });
  // Caps at 10 items
  if (list.length > 10) {
    list.pop();
  }
  saveHistory(list);
  renderHistory();
}

function removeFromHistory(url) {
  let list = getHistory();
  list = list.filter(item => item.url !== url);
  saveHistory(list);
  renderHistory();
}

function clearHistory() {
  saveHistory([]);
  renderHistory();
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function renderHistory() {
  if (!historyList) return;
  
  const list = getHistory();
  if (list.length === 0) {
    historyList.innerHTML = '<div class="empty-history-text">No recently played streams</div>';
    return;
  }

  historyList.innerHTML = list.map(item => {
    return `
      <div class="history-item" data-url="${encodeURIComponent(item.url)}">
        <div class="history-info">
          <span class="history-url" title="${item.url}">${item.url}</span>
          <span class="history-time">${formatRelativeTime(item.timestamp)}</span>
        </div>
        <div class="history-actions">
          <button class="btn-icon play-history" title="Play stream">
            <i class="fa-solid fa-play"></i>
          </button>
          <button class="btn-icon delete-history" title="Delete from log">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Attach dynamic event listeners to history cards
  historyList.querySelectorAll('.history-item').forEach(card => {
    const url = decodeURIComponent(card.getAttribute('data-url'));
    
    // Play full history stream on click of the item (except delete)
    card.addEventListener('click', (e) => {
      if (e.target.closest('.delete-history')) {
        e.stopPropagation();
        removeFromHistory(url);
        return;
      }
      
      streamInput.value = url;
      loadStream(url);
    });
  });
}

// App Listeners setup
streamForm.addEventListener('submit', (e) => {
  e.preventDefault();
  loadStream(streamInput.value);
});

presetButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const url = btn.getAttribute('data-url');
    streamInput.value = url;
    loadStream(url);
  });
});

btnClearHistory.addEventListener('click', (e) => {
  e.stopPropagation();
  if (confirm('Clear the stream cache history log?')) {
    clearHistory();
  }
});

// App Start Initialization
document.addEventListener('DOMContentLoaded', () => {
  initPlyr();
  renderHistory();
  
  // Set up repeating buffer monitor
  setInterval(updateBufferStat, 300);

  // Load the first preset video by default on startup
  if (presetButtons.length > 0) {
    const firstPreset = presetButtons[0];
    const url = firstPreset.getAttribute('data-url');
    streamInput.value = url;
    
    // We pass the URL but catch autoplay errors gracefully (since user has not interacted with the DOM yet)
    loadStream(url);
  }
});
