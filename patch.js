const fs = require('fs');
let content = fs.readFileSync('index.html', 'utf8');

const target = `  function renderSubmissionsList(subs) {
      if (!subs || subs.length === 0) {
          document.getElementById('test-submissions-list').innerHTML = '<p>No submissions found.</p>';
          return;
      }
      let html = '<div style="display:flex; flex-direction:column; gap:10px;">';
      subs.forEach((sub, idx) => {
          const realIdx = (window._cachedSubmissions || []).indexOf(sub);
          const date = new Date(sub.submittedAt).toLocaleString();
          html += \`
              <div style="background:#fff; border: 1px solid var(--line); padding: 15px; border-radius: 8px; display:flex; justify-content:space-between; align-items:center;">
                  <div>
                      <h4 style="margin:0 0 5px 0;">\${escapeHtml(sub.studentName)} <span style="font-weight:normal; color:var(--text-light); font-size:12px;">(Code: \${escapeHtml(sub.code)})</span></h4>
                      <div style="font-size: 12px; color:var(--text-light);">\${date}</div>
                  </div>
                  <button class="btn btn-outline btn-sm" onclick='viewSubmissionDetails(\${realIdx})'><i class="fas fa-eye"></i> View</button>
              </div>
          \`;
      });
      html += '</div>';
      document.getElementById('test-submissions-list').innerHTML = html;
  }`;

const replacement = `  function renderSubmissionsList(subs) {
      if (!subs || subs.length === 0) {
          document.getElementById('test-submissions-list').innerHTML = '<p>No submissions found.</p>';
          return;
      }
      let html = '<div style="display:flex; flex-direction:column; gap:10px;">';
      subs.forEach((sub, idx) => {
          const realIdx = (window._cachedSubmissions || []).indexOf(sub);
          const date = new Date(sub.submittedAt).toLocaleString();
          html += \`
              <div style="background:#fff; border: 1px solid var(--line); padding: 15px; border-radius: 8px; display:flex; justify-content:space-between; align-items:center;">
                  <div>
                      <h4 style="margin:0 0 5px 0;">\${escapeHtml(sub.studentName)} <span style="font-weight:normal; color:var(--text-light); font-size:12px;">(Code: \${escapeHtml(sub.code)})</span></h4>
                      <div style="font-size: 12px; color:var(--text-light);">\${date}</div>
                  </div>
                  <div style="display:flex; gap: 8px;">
                      <button class="btn btn-outline btn-sm" onclick='viewSubmissionDetails(\${realIdx})'><i class="fas fa-eye"></i> View</button>
                      <button class="btn btn-outline btn-sm" style="color:var(--danger, #ef4444); border-color:var(--danger, #ef4444);" onclick='deleteTestSubmission("\${escapeHtml(sub.code)}", "\${escapeHtml(sub.studentName).replace(/"/g, '&quot;')}")'><i class="fas fa-trash"></i> Delete</button>
                  </div>
              </div>
          \`;
      });
      html += '</div>';
      document.getElementById('test-submissions-list').innerHTML = html;
  }

  async function deleteTestSubmission(code, studentName) {
      if (!confirm(\`Are you sure you want to delete the submission from \${studentName}?\`)) return;
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
  }`;

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync('index.html', content);
    console.log("Success");
} else {
    console.log("Failed");
}
