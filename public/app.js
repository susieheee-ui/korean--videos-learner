// ===== State =====
let player = null;
let subtitles = [];
let analysisData = {};  // index -> analysis result
let syncInterval = null;
let currentActiveIndex = -1;

// ===== DOM Elements =====
const $ = id => document.getElementById(id);
const videoUrlInput = $('videoUrl');
const loadBtn = $('loadBtn');
const analyzeBtn = $('analyzeBtn');
const settingsBtn = $('settingsBtn');
const settingsModal = $('settingsModal');
const saveSettingsBtn = $('saveSettings');
const cancelSettingsBtn = $('cancelSettings');
const apiProviderSelect = $('apiProvider');
const apiKeyInput = $('apiKey');
const transcriptContent = $('transcriptContent');
const tooltip = $('tooltip');
const loadingOverlay = $('loadingOverlay');
const loadingText = $('loadingText');
const playerPlaceholder = $('playerPlaceholder');

// ===== Settings =====
function loadSettings() {
  const provider = localStorage.getItem('kyl_provider') || 'claude';
  const key = localStorage.getItem('kyl_apiKey') || '';
  apiProviderSelect.value = provider;
  apiKeyInput.value = key;
}

function saveSettings() {
  localStorage.setItem('kyl_provider', apiProviderSelect.value);
  localStorage.setItem('kyl_apiKey', apiKeyInput.value);
}

function getSettings() {
  return {
    provider: localStorage.getItem('kyl_provider') || 'claude',
    apiKey: localStorage.getItem('kyl_apiKey') || ''
  };
}

// ===== YouTube Player =====
function initYouTubeAPI() {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

window.onYouTubeIframeAPIReady = function() {
  // Player will be created when a video is loaded
};

function loadVideo(videoId) {
  playerPlaceholder.classList.add('hidden');

  if (player) {
    player.loadVideoById(videoId);
  } else {
    player = new YT.Player('player', {
      videoId: videoId,
      playerVars: {
        autoplay: 0,
        cc_load_policy: 0,
        hl: 'ko',
        rel: 0
      },
      events: {
        onReady: () => startSync(),
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) startSync();
          else if (e.data === YT.PlayerState.PAUSED) stopSync();
        }
      }
    });
  }
}

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ===== Subtitle Sync =====
function startSync() {
  stopSync();
  syncInterval = setInterval(() => {
    if (!player || !player.getCurrentTime) return;
    const time = player.getCurrentTime();
    let activeIdx = -1;
    for (let i = 0; i < subtitles.length; i++) {
      const s = subtitles[i];
      if (time >= s.start && time < s.start + s.dur) {
        activeIdx = i;
        break;
      }
    }
    if (activeIdx !== currentActiveIndex) {
      updateActiveLine(activeIdx);
      currentActiveIndex = activeIdx;
    }
  }, 300);
}

function stopSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

function updateActiveLine(idx) {
  const prev = transcriptContent.querySelector('.transcript-line.active');
  if (prev) prev.classList.remove('active');

  if (idx >= 0) {
    const line = transcriptContent.querySelector(`[data-index="${idx}"]`);
    if (line) {
      line.classList.add('active');
      // Auto-scroll to active line
      line.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

// ===== Transcript Rendering =====
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function renderTranscript() {
  if (subtitles.length === 0) {
    transcriptContent.innerHTML = '<div class="transcript-placeholder"><p>No subtitles found</p></div>';
    return;
  }

  transcriptContent.innerHTML = subtitles.map((sub, i) => {
    const analysis = analysisData[i];
    const koreanHTML = analysis ? buildAnnotatedText(sub.text, analysis.annotations) : escapeHTML(sub.text);
    const chineseHTML = analysis ? escapeHTML(analysis.chinese) : '';

    return `
      <div class="transcript-line" data-index="${i}" data-start="${sub.start}">
        <div class="line-time">${formatTime(sub.start)}</div>
        <div class="line-korean">${koreanHTML}</div>
        ${chineseHTML ? `<div class="line-chinese">${chineseHTML}</div>` : ''}
      </div>
    `;
  }).join('');

  // Click to seek
  transcriptContent.querySelectorAll('.transcript-line').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't seek if clicking an annotation
      if (e.target.closest('.anno')) return;
      const start = parseFloat(el.dataset.start);
      if (player && player.seekTo) {
        player.seekTo(start, true);
        player.playVideo();
      }
    });
  });

  // Annotation tooltips
  transcriptContent.querySelectorAll('.anno').forEach(el => {
    el.addEventListener('mouseenter', showTooltip);
    el.addEventListener('mouseleave', hideTooltip);
  });
}

function buildAnnotatedText(korean, annotations) {
  if (!annotations || annotations.length === 0) return escapeHTML(korean);

  // Sort annotations by position in the text (longest match first for overlaps)
  const sorted = [...annotations]
    .filter(a => korean.includes(a.text))
    .sort((a, b) => {
      const posA = korean.indexOf(a.text);
      const posB = korean.indexOf(b.text);
      if (posA !== posB) return posA - posB;
      return b.text.length - a.text.length;
    });

  // Build annotated HTML avoiding overlaps
  let result = '';
  let pos = 0;
  const used = new Set();

  for (const anno of sorted) {
    const idx = korean.indexOf(anno.text, pos);
    if (idx === -1) continue;

    // Check if this range overlaps with already used ranges
    let overlaps = false;
    for (const u of used) {
      if (idx < u.end && idx + anno.text.length > u.start) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;

    if (idx > pos) {
      result += escapeHTML(korean.slice(pos, idx));
    }

    const typeLabel = { vocabulary: 'Vocab', grammar: 'Grammar', idiom: 'Idiom' };
    result += `<span class="anno anno-${anno.type}" data-type="${anno.type}" data-word="${escapeAttr(anno.text)}" data-explain="${escapeAttr(anno.explanation)}">${escapeHTML(anno.text)}</span>`;

    used.add({ start: idx, end: idx + anno.text.length });
    pos = idx + anno.text.length;
  }

  if (pos < korean.length) {
    result += escapeHTML(korean.slice(pos));
  }

  return result;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== Tooltip =====
function showTooltip(e) {
  const el = e.currentTarget;
  const type = el.dataset.type;
  const word = el.dataset.word;
  const explain = el.dataset.explain;

  const typeLabels = { vocabulary: 'Vocabulary', grammar: 'Grammar', idiom: 'Idiom' };

  tooltip.innerHTML = `
    <div class="tooltip-type tt-${type}">${typeLabels[type]}</div>
    <div class="tooltip-word">${escapeHTML(word)}</div>
    <div class="tooltip-explain">${escapeHTML(explain)}</div>
  `;
  tooltip.classList.remove('hidden');

  // Position
  const rect = el.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 8;

  // Keep within viewport
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  if (left + tw > window.innerWidth - 12) left = window.innerWidth - tw - 12;
  if (top + th > window.innerHeight - 12) top = rect.top - th - 8;

  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function hideTooltip() {
  tooltip.classList.add('hidden');
}

// ===== Loading =====
function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

// ===== API Calls =====
async function fetchSubtitles(videoId) {
  const res = await fetch(`/api/subtitles?videoId=${videoId}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.subtitles;
}

// Try to load pre-built analysis data for a video
async function loadPrebuiltAnalysis(videoId) {
  try {
    const res = await fetch(`/data/${videoId}.json`);
    if (!res.ok) return false;
    const data = await res.json();
    if (data.analysis) {
      for (const [idx, analysis] of Object.entries(data.analysis)) {
        analysisData[parseInt(idx)] = analysis;
      }
      return true;
    }
  } catch {}
  return false;
}

async function analyzeSubtitles() {
  const settings = getSettings();
  if (!settings.apiKey) {
    alert('Please configure your API key in Settings first.');
    settingsModal.classList.remove('hidden');
    return;
  }

  showLoading('AI is analyzing Korean text...');
  analyzeBtn.disabled = true;

  try {
    // Analyze in batches of 10 lines
    const batchSize = 10;
    for (let i = 0; i < subtitles.length; i += batchSize) {
      const batch = subtitles.slice(i, i + batchSize);
      const lines = batch.map(s => s.text);

      loadingText.textContent = `Analyzing lines ${i + 1}-${Math.min(i + batchSize, subtitles.length)} of ${subtitles.length}...`;

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines,
          provider: settings.provider,
          apiKey: settings.apiKey
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Map results back to subtitle indices
      if (data.lines) {
        data.lines.forEach((line, j) => {
          analysisData[i + j] = line;
        });
      }

      // Re-render after each batch so user sees progress
      renderTranscript();
    }
  } catch (err) {
    alert('Analysis failed: ' + err.message);
  } finally {
    hideLoading();
    analyzeBtn.disabled = false;
  }
}

// ===== Event Handlers =====
loadBtn.addEventListener('click', async () => {
  const url = videoUrlInput.value.trim();
  if (!url) return;

  const videoId = extractVideoId(url);
  if (!videoId) {
    alert('Invalid YouTube URL. Please paste a valid YouTube video link.');
    return;
  }

  showLoading('Loading subtitles...');
  try {
    subtitles = await fetchSubtitles(videoId);
    analysisData = {};
    loadVideo(videoId);

    // Try to load pre-built analysis (translations + annotations)
    loadingText.textContent = 'Loading translations...';
    const hasPrebuilt = await loadPrebuiltAnalysis(videoId);

    renderTranscript();
    analyzeBtn.disabled = false;

    if (hasPrebuilt) {
      analyzeBtn.textContent = '✓ Pre-analyzed';
      analyzeBtn.style.opacity = '0.7';
    }
  } catch (err) {
    alert('Failed to load: ' + err.message);
  } finally {
    hideLoading();
  }
});

// Enter key in URL input
videoUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadBtn.click();
});

analyzeBtn.addEventListener('click', analyzeSubtitles);

// Settings modal
settingsBtn.addEventListener('click', () => {
  loadSettings();
  settingsModal.classList.remove('hidden');
});

saveSettingsBtn.addEventListener('click', () => {
  saveSettings();
  settingsModal.classList.add('hidden');
});

cancelSettingsBtn.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

settingsModal.querySelector('.modal-overlay').addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

// ===== Init =====
initYouTubeAPI();
loadSettings();
