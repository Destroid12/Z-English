$content = Get-Content index.html -Raw -Encoding UTF8

$target = @"
                  <button class="btn btn-outline btn-sm" onclick='viewSubmissionDetails(`${realIdx})'><i class="fas fa-eye"></i> View</button>
              </div>
"@

$replace = @"
                  <div style="display:flex; gap: 8px;">
                      <button class="btn btn-outline btn-sm" onclick='viewSubmissionDetails(`${realIdx})'><i class="fas fa-eye"></i> View</button>
                      <button class="btn btn-outline btn-sm" style="color:var(--danger, #ef4444); border-color:var(--danger, #ef4444);" onclick='deleteTestSubmission("`${escapeHtml(sub.code)}", "`${escapeHtml(sub.studentName).replace(/"/g, '&quot;')}")'><i class="fas fa-trash"></i> Delete</button>
                  </div>
              </div>
"@

$content = $content.Replace($target, $replace)

$target2 = @"
  function viewSubmissionDetails(index) {
"@

$replace2 = @"
  async function deleteTestSubmission(code, studentName) {
      if (!confirm(`Are you sure you want to delete the submission from `${studentName}?`)) return;
      try {
          const res = await callBackendGet(new URLSearchParams({ action: 'deleteTestSubmission', token: sessionToken, code }));
          if (res.success) {
              const currentTestId = document.getElementById('testSessionSelectAdmin').value;
              loadTestSubmissions(currentTestId);
          } else {
              alert('Failed to delete submission: ' + (res.message || 'Unknown error'));
          }
      } catch (e) {
          alert('Network error.');
      }
  }

  function viewSubmissionDetails(index) {
"@

$content = $content.Replace($target2, $replace2)

Set-Content index.html $content -Encoding UTF8
Write-Host "Success"
