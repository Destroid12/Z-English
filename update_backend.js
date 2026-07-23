const fs = require('fs');
let content = fs.readFileSync('C:\\Users\\ziyad\\.gemini\\antigravity\\brain\\6bac825b-de1c-4dd2-b457-8154cd392a47\\backend_script.js', 'utf8');

const target1 = `    if (action === 'deleteTestCode') return _deleteTestCode(eProxy);`;
const replace1 = `    if (action === 'deleteTestCode') return _deleteTestCode(eProxy);
    if (action === 'deleteTestSubmission') return _deleteTestSubmission(eProxy);`;

const target2 = `    if (action === 'listTestSubmissions') return _listTestSubmissions(e);`;
const replace2 = `    if (action === 'listTestSubmissions') return _listTestSubmissions(e);
    if (action === 'deleteTestSubmission') return _deleteTestSubmission(e);`;

const target3 = `function _deleteTestCode(e) {`;
const replace3 = `function _deleteTestSubmission(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;
  
  const code = e.parameter.code;
  const sheet = _sheet('TestSubmissions');
  if (!sheet) return _json({ success: false, message: 'No submissions sheet found' });

  const data = sheet.getDataRange().getValues();
  // Loop backwards to delete without messing up row indices
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]) === String(code)) { // data[i][1] is the Code column
      sheet.deleteRow(i + 1);
      return _json({ success: true });
    }
  }
  return _json({ success: false, message: 'Submission not found' });
}

function _deleteTestCode(e) {`;

if (content.includes(target1) && content.includes(target2) && content.includes(target3)) {
    content = content.replace(target1, replace1).replace(target2, replace2).replace(target3, replace3);
    fs.writeFileSync('C:\\Users\\ziyad\\.gemini\\antigravity\\brain\\6bac825b-de1c-4dd2-b457-8154cd392a47\\backend_script.js', content);
    console.log("Success");
} else {
    console.log("Failed to find targets");
}
