$slidesDir = 'C:\Users\ziyad\.gemini\antigravity\scratch\Z-English\test_ppt\ppt\slides'
$relsDir = Join-Path $slidesDir '_rels'

$out = @()
for ($i=1; $i -le 30; $i++) {
    $slideFile = Join-Path $slidesDir "slide$i.xml"
    $relFile = Join-Path $relsDir "slide$i.xml.rels"
    
    if (-not (Test-Path $slideFile)) { continue }
    
    $xml = Get-Content $slideFile -Raw
    $textRegex = '<a:t[^>]*>(.*?)</a:t>'
    $textPieces = ([regex]::Matches($xml, $textRegex) | Foreach-Object { $_.Groups[1].Value }) -join ' | '
    
    $images = ''
    if (Test-Path $relFile) {
        $relXml = Get-Content $relFile -Raw
        $imgRegex = 'Target="\.\./media/([^"]+)"'
        $images = ([regex]::Matches($relXml, $imgRegex) | Foreach-Object { $_.Groups[1].Value }) -join ', '
    }
    
    $out += "--- Slide $i ---"
    $out += "TEXT: $textPieces"
    $out += "IMAGES: $images"
}

$out | Set-Content 'extract.txt'
