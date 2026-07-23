$editor = Get-Content 'C:\Users\ziyad\.gemini\antigravity\scratch\Z-English\editor.html' -Raw
$editor = $editor -replace '<button id="saveBtn" class="btn"><i class="fas fa-save"></i> Save to Session</button>', '<button id="previewSessionBtn" class="btn" style="background-color: var(--z-orange);"><i class="fas fa-eye"></i> Preview Session</button> <button id="saveBtn" class="btn"><i class="fas fa-save"></i> Save to Session</button>'

$previewLogic = @'
  document.getElementById('previewSessionBtn').onclick = () => {
      if (slides.length === 0) {
          setStatus('Add at least one slide to preview.', 'error');
          return;
      }
      localStorage.setItem('zenglish_preview_session', JSON.stringify(slides));
      window.open('player.html?preview=1', '_blank');
  };
'@

$editor = $editor -replace 'document.getElementById\(''saveBtn''\).onclick = saveSession;', "document.getElementById('saveBtn').onclick = saveSession;`n$previewLogic"
$editor | Set-Content 'C:\Users\ziyad\.gemini\antigravity\scratch\Z-English\editor.html'

$player = Get-Content 'C:\Users\ziyad\.gemini\antigravity\scratch\Z-English\player.html' -Raw
$playerLoadLogic = @'
  const urlParams = new URLSearchParams(window.location.search);
  const isPreview = urlParams.get('preview') === '1';

  async function initPlayer() {
    if (isPreview) {
        const previewData = localStorage.getItem('zenglish_preview_session');
        if (previewData) {
            try {
                slides = JSON.parse(previewData);
                initRender();
                return;
            } catch(e) {
                console.error('Preview error', e);
            }
        }
    }
'@
$player = $player -replace 'async function initPlayer\(\) \{', $playerLoadLogic
$player | Set-Content 'C:\Users\ziyad\.gemini\antigravity\scratch\Z-English\player.html'
