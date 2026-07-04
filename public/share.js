(function(){
  const root = document.getElementById('shareRoot');
  const token = location.pathname.split('/').filter(Boolean).pop();

  function esc(v){
    return String(v == null ? '' : v)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function fileUrl(file){
    const id = file.driveFileId || file.drive_file_id || file.id || '';
    if(id) return 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/preview';
    if(file.path) return '/' + String(file.path).replace(/^\/+/, '');
    return '#';
  }

  function fileDownloadUrl(file){
    const id = file.driveFileId || file.drive_file_id || file.id || '';
    if(id) return 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id);
    if(file.path) return '/' + String(file.path).replace(/^\/+/, '');
    return '#';
  }

  function render(data){
    const vessel = data.vessel || {};
    const folders = data.folders || [];
    const files = (data.files || data.documents || []).filter(f => /\.pdf$/i.test(f.name || ''));
    const allowDownload = data.allowDownload !== false && data.allow_download !== false;

    const byFolder = {};
    files.forEach(f => {
      const fid = String(f.folderId || f.folder_id || '');
      if(!byFolder[fid]) byFolder[fid] = [];
      byFolder[fid].push(f);
    });

    let html = `
      <section class="vessel-card">
        <h1>${esc(vessel.name || 'Shared vessel')}</h1>
        <div class="meta">
          <span>IMO: ${esc(vessel.imo || '-')}</span>
          <span>Type: ${esc(vessel.type || '-')}</span>
          <span>Flag: ${esc(vessel.flag || '-')}</span>
        </div>
      </section>
    `;

    html += '<section class="folders">';
    folders.forEach((f, idx) => {
      const list = byFolder[String(f.id)] || [];
      html += `<div class="folder-block"><h2>${String(idx + 1).padStart(2,'0')} · ${esc(f.name)}</h2>`;

      if(!list.length){
        html += '<div class="empty">No PDF documents available in this folder.</div>';
      } else {
        html += '<div class="doc-table">';
        list.forEach(file => {
          html += `
            <div class="doc-row">
              <div class="doc-main">
                <div class="doc-title">${esc(file.name || 'PDF document')}</div>
                <div class="doc-sub">Uploaded by: ${esc(file.by || '-')} · Size: ${esc(file.size || '-')}</div>
              </div>
              <div class="doc-files">
                <a class="file-btn" href="${esc(fileUrl(file))}" target="_blank" rel="noopener">Open PDF</a>
                ${allowDownload ? `<a class="file-btn muted" href="${esc(fileDownloadUrl(file))}" target="_blank" rel="noopener">Download</a>` : ''}
              </div>
            </div>`;
        });
        html += '</div>';
      }
      html += '</div>';
    });
    html += '</section>';
    root.innerHTML = html;
  }

  async function load(){
    if(!token){
      root.innerHTML = '<div class="error">Invalid share link. Token missing.</div>';
      return;
    }
    try{
      const res = await fetch('/api/share/' + encodeURIComponent(token));
      const data = await res.json();
      if(!res.ok || !(data.success || data.ok)){
        throw new Error(data.message || data.error || 'Unable to load shared vessel.');
      }
      render(data);
    }catch(e){
      root.innerHTML = `<div class="error">${esc(e.message || 'Unable to load shared vessel.')}</div>`;
    }
  }
  load();
})();
