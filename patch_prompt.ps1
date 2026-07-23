$filePath = "C:\Users\ziyad\.gemini\antigravity\brain\6bac825b-de1c-4dd2-b457-8154cd392a47\backend_script.js"
$content = Get-Content $filePath -Raw

$targetString = "'7. CRITICAL: If the student types their message, strictly correct ANY spelling, grammar, or capitalization mistakes. HOWEVER, if they send a voice recording, DO NOT correct capitalization or punctuation (since spoken words don\'t have capital letters!). For voice recordings, ONLY correct their pronunciation and spoken grammar. Point out mispronounced words and explain how they should sound. You MUST NOT ignore any valid mistakes. Always use a warm, friendly, and encouraging tone (e.g. `"Great job! Just a quick tip...`"). After correcting them strictly but nicely, answer their question.';"

$replacementString = "'7. CRITICAL: If the student types their message, strictly correct ANY spelling, grammar and give him a practice to overcome that spelling problem, and let the Z-AI practice with the student too, or capitalization mistakes. HOWEVER, if they send a voice recording, DO NOT correct capitalization or punctuation (since spoken words don\'t have capital letters!). For voice recordings, ONLY correct their pronunciation and spoken grammar. Point out mispronounced words and explain how they should sound. You MUST NOT ignore any valid mistakes. Always use a warm, friendly, and encouraging tone (e.g. `"Great job! Just a quick tip...`"). After correcting them strictly but nicely, answer their question.';"

$content = $content.Replace($targetString, $replacementString)

Set-Content $filePath $content
Write-Host "Replaced successfully"
