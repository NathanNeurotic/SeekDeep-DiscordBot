const fs = require('fs');

function applyFix() {
    let content = fs.readFileSync('index.js', 'utf8');

    // --- 5. BigInt globally ---
    content = content.replace(/try \{ return JSON\.stringify\(a\); \} catch \{ return String\(a\); \}/g, "try { return JSON.stringify(a, (_, v) => typeof v === 'bigint' ? v.toString() : v); } catch { return String(a); }");
    content = content.replace(/JSON\.stringify\(\([^,]+?\),\s*null,\s*2\)/g, "JSON.stringify($1, (_, v) => typeof v === 'bigint' ? v.toString() : v, null, 2)");
    content = content.replace(/body:\s*JSON\.stringify\(body\)/g, "body: JSON.stringify(body, (_, v) => typeof v === 'bigint' ? v.toString() : v)");
    content = content.replace(/try \{ text = typeof detail === 'string' \? detail : JSON\.stringify\(detail\); \} catch \{ text = String\(detail\); \}/g, "try { text = typeof detail === 'string' ? detail : JSON.stringify(detail, (_, v) => typeof v === 'bigint' ? v.toString() : v); } catch { text = String(detail); }");
    content = content.replace(/detailText = typeof detail === 'string' \? detail : JSON\.stringify\(detail\);/g, "detailText = typeof detail === 'string' ? detail : JSON.stringify(detail, (_, v) => typeof v === 'bigint' ? v.toString() : v);");

    // One more for manifest inside export:
    content = content.replace(/const jsonBuf = Buffer\.from\(JSON\.stringify\(manifest, null, 2\), 'utf8'\);/g, "const jsonBuf = Buffer.from(JSON.stringify(manifest, (_, v) => typeof v === 'bigint' ? v.toString() : v, null, 2), 'utf8');");

    fs.writeFileSync('index.js', content);
}
applyFix();
