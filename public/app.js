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
const backBtn = $('backBtn');
const videoLibrary = $('videoLibrary');
const libraryGrid = $('libraryGrid');
const viewTermsBtn = $('viewTermsBtn');
const termsModal = $('termsModal');
const termsTitle = $('termsTitle');
const termsList = $('termsList');
const closeTermsBtn = $('closeTermsBtn');
const downloadTermsBtn = $('downloadTermsBtn');

// Current video metadata
let currentVideoTitle = '';

// ===== Video Library =====
async function loadLibrary() {
  try {
    const res = await fetch('/data/library.json');
    if (!res.ok) return;
    const videos = await res.json();
    renderLibrary(videos);
  } catch {}
}

function renderLibrary(videos) {
  if (!videos.length) return;
  libraryGrid.innerHTML = videos.map(v => `
    <div class="library-card" data-video-id="${v.videoId}" data-video-title="${escapeAttr(v.title)}">
      <img class="library-thumb" src="https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg" alt="${v.title}" />
      <div class="library-info">
        <h3>${v.title}</h3>
        <div class="library-channel">${v.channel}</div>
        <div class="library-desc">${v.description}</div>
        <div class="library-tags">${v.tags.map(t => `<span class="library-tag">${t}</span>`).join('')}</div>
        <div class="library-stats">${v.subtitleCount} subtitles / ${v.annotationCount} annotations</div>
      </div>
    </div>
  `).join('');

  libraryGrid.querySelectorAll('.library-card').forEach(card => {
    card.addEventListener('click', () => {
      const videoId = card.dataset.videoId;
      currentVideoTitle = card.dataset.videoTitle || '';
      videoUrlInput.value = `https://www.youtube.com/watch?v=${videoId}`;
      loadBtn.click();
    });
  });
}

// ===== Terms (Vocabulary/Grammar/Idiom) =====
function collectTerms() {
  // Collect all annotations, deduplicating by text+type
  const map = new Map();
  for (const analysis of Object.values(analysisData)) {
    if (!analysis.annotations) continue;
    for (const anno of analysis.annotations) {
      const key = `${anno.type}:${anno.text}`;
      if (map.has(key)) {
        map.get(key).count++;
      } else {
        map.set(key, {
          text: anno.text,
          type: anno.type,
          explanation: anno.explanation,
          count: 1
        });
      }
    }
  }
  return Array.from(map.values());
}

function renderTerms(filter = 'all') {
  const allTerms = collectTerms();
  if (allTerms.length === 0) {
    termsList.innerHTML = '<div class="terms-empty">No terms yet. Please analyze the video first.</div>';
    return;
  }

  const typeLabels = {
    vocabulary: '单词 Vocabulary',
    grammar: '语法 Grammar',
    idiom: '地道表达 Idiom'
  };

  let html = '';

  if (filter === 'all') {
    // Group by type
    for (const type of ['vocabulary', 'grammar', 'idiom']) {
      const terms = allTerms.filter(t => t.type === type);
      if (terms.length === 0) continue;
      html += `<div class="terms-group">
        <div class="terms-group-title">${typeLabels[type]} · ${terms.length}</div>`;
      for (const t of terms) {
        html += renderTermItem(t);
      }
      html += `</div>`;
    }
  } else {
    const terms = allTerms.filter(t => t.type === filter);
    if (terms.length === 0) {
      termsList.innerHTML = '<div class="terms-empty">No terms in this category.</div>';
      return;
    }
    html += `<div class="terms-group"><div class="terms-group-title">${typeLabels[filter]} · ${terms.length}</div>`;
    for (const t of terms) html += renderTermItem(t);
    html += `</div>`;
  }

  termsList.innerHTML = html;
}

function renderTermItem(t) {
  const badgeLabels = { vocabulary: 'Vocab', grammar: 'Grammar', idiom: 'Idiom' };
  return `<div class="term-item">
    <div class="term-badge term-badge-${t.type}">${badgeLabels[t.type]}</div>
    <div class="term-content">
      <div class="term-word">${escapeHTML(t.text)}${t.count > 1 ? `<span class="term-count">×${t.count}</span>` : ''}</div>
      <div class="term-explanation">${escapeHTML(t.explanation)}</div>
    </div>
  </div>`;
}

function openTermsModal() {
  termsTitle.textContent = `单词语法本 · ${currentVideoTitle || ''}`.trim();
  renderTerms('all');
  // Reset tabs to "all"
  termsModal.querySelectorAll('.terms-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === 'all');
  });
  termsModal.classList.remove('hidden');
}

function closeTermsModal() {
  termsModal.classList.add('hidden');
}

function downloadTerms() {
  const allTerms = collectTerms();
  if (allTerms.length === 0) return;

  const typeLabels = {
    vocabulary: '单词 Vocabulary',
    grammar: '语法 Grammar',
    idiom: '地道表达 Idiom'
  };

  let content = `# ${currentVideoTitle || 'Korean Learning Terms'}\n\n`;
  content += `来源: KoreanClip\n`;
  content += `总数: ${allTerms.length} 个\n\n`;
  content += `---\n\n`;

  for (const type of ['vocabulary', 'grammar', 'idiom']) {
    const terms = allTerms.filter(t => t.type === type);
    if (terms.length === 0) continue;
    content += `## ${typeLabels[type]} (${terms.length})\n\n`;
    terms.forEach((t, i) => {
      content += `${i + 1}. **${t.text}**${t.count > 1 ? ` (×${t.count})` : ''}\n`;
      content += `   ${t.explanation}\n\n`;
    });
  }

  // Create filename from video title (sanitized)
  const safeTitle = (currentVideoTitle || 'korean-terms').replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
  const filename = `${safeTitle}.md`;

  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function showLibrary() {
  videoLibrary.classList.remove('hidden');
  transcriptContent.classList.add('hidden');
}

function hideLibrary() {
  videoLibrary.classList.add('hidden');
  transcriptContent.classList.remove('hidden');
  backBtn.classList.remove('hidden');
}

function backToLibrary() {
  showLibrary();
  backBtn.classList.add('hidden');
  viewTermsBtn.classList.add('hidden');
  videoUrlInput.value = '';
  playerPlaceholder.classList.remove('hidden');
  if (player) { player.destroy(); player = null; }
  stopSync();
  subtitles = [];
  analysisData = {};
  currentActiveIndex = -1;
  currentVideoTitle = '';
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = 'AI Analyze';
  analyzeBtn.style.opacity = '1';
}

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
    // Find the last subtitle whose start time <= current time
    // (handles gaps between subtitles correctly)
    let activeIdx = -1;
    for (let i = 0; i < subtitles.length; i++) {
      if (subtitles[i].start <= time) {
        activeIdx = i;
      } else {
        break;
      }
    }
    if (activeIdx !== currentActiveIndex) {
      updateActiveLine(activeIdx);
      currentActiveIndex = activeIdx;
    }
  }, 250);
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
      // Manually scroll the transcript container only (not the whole page)
      const containerHeight = transcriptContent.clientHeight;
      const lineTop = line.offsetTop;
      const lineHeight = line.offsetHeight;
      const targetScroll = lineTop - (containerHeight / 2) + (lineHeight / 2);
      transcriptContent.scrollTo({
        top: targetScroll,
        behavior: 'smooth'
      });
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

// Try to load pre-built data (subtitles + analysis) for a video
async function loadPrebuiltData(videoId) {
  try {
    const res = await fetch(`/data/${videoId}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch {}
  return null;
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

  showLoading('Loading...');
  try {
    analysisData = {};
    hideLibrary();

    // Try pre-built data first (works on Vercel without backend)
    const prebuilt = await loadPrebuiltData(videoId);

    if (prebuilt && prebuilt.subtitles) {
      subtitles = prebuilt.subtitles;
      if (prebuilt.analysis) {
        for (const [idx, a] of Object.entries(prebuilt.analysis)) {
          analysisData[parseInt(idx)] = a;
        }
      }
    } else {
      // Fallback to API (local dev with yt-dlp)
      loadingText.textContent = 'Loading subtitles...';
      subtitles = await fetchSubtitles(videoId);
    }

    loadVideo(videoId);
    renderTranscript();
    analyzeBtn.disabled = false;

    if (Object.keys(analysisData).length > 0) {
      analyzeBtn.textContent = '✓ Pre-analyzed';
      analyzeBtn.style.opacity = '0.7';
      viewTermsBtn.classList.remove('hidden');
    } else {
      viewTermsBtn.classList.add('hidden');
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
backBtn.addEventListener('click', backToLibrary);

// Terms modal
viewTermsBtn.addEventListener('click', openTermsModal);
closeTermsBtn.addEventListener('click', closeTermsModal);
downloadTermsBtn.addEventListener('click', downloadTerms);
termsModal.querySelector('.modal-overlay').addEventListener('click', closeTermsModal);
termsModal.querySelectorAll('.terms-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    termsModal.querySelectorAll('.terms-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderTerms(tab.dataset.tab);
  });
});

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
loadLibrary();
