// src/mailer.js — send email via the Microsoft Graph API (app-only OAuth). Ported straight
// from the GoCanvas/PestPac integration's ms_graph_auth.py + email_sender.py so BUU reuses the
// same proven send path. Sends AS a shared mailbox (default help-autoreply@palmettoexterminators.net).
//
// SECRETS NEVER LIVE IN THIS FILE OR THE REPO. The Azure app config (tenantId, clientId,
// clientSecret, fromMailbox) is read from the Windows Credential Vault via keytar, under
// service "BUU2" / account "msGraphEmail" (a JSON blob). Set it once per machine in Settings.
//
// All plain HTTPS via Node's built-in `https` — no new dependencies.

const https = require('https');

const GRAPH_HOST = 'graph.microsoft.com';
const LOGIN_HOST = 'login.microsoftonline.com';
const INLINE_ATTACHMENT_LIMIT_BYTES = 3 * 1024 * 1024; // Graph inline (base64-in-JSON) cap
const KEYTAR_SERVICE = 'BUU2';
const KEYTAR_ACCOUNT = 'msGraphEmail';
const DEFAULT_FROM = 'help-autoreply@palmettoexterminators.net';

let _accessToken = null;
let _expiresAt = 0; // epoch ms

function _httpsPost(host, path, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: 'POST', headers }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Microsoft Graph request timed out')); });
    req.write(bodyStr);
    req.end();
  });
}

// Read the email config JSON from the vault. `keytar` is passed in (main provides it).
async function getEmailConfig(keytar) {
  if (!keytar) throw new Error('Credential vault unavailable (keytar not loaded).');
  const raw = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  if (!raw) throw new Error('Email is not set up on this computer. Enter the email credentials in Settings first.');
  let c;
  try { c = JSON.parse(raw); } catch (e) { throw new Error('Stored email config is corrupt; re-enter it in Settings.'); }
  if (!c.tenantId || !c.clientId || !c.clientSecret) throw new Error('Email config is incomplete; re-enter it in Settings.');
  c.fromMailbox = c.fromMailbox || DEFAULT_FROM;
  return c;
}

// Save/replace the email config in the vault (used by the Settings panel).
async function setEmailConfig(keytar, { tenantId, clientId, clientSecret, fromMailbox }) {
  if (!keytar) throw new Error('Credential vault unavailable (keytar not loaded).');
  if (!tenantId || !clientId || !clientSecret) throw new Error('tenantId, clientId and clientSecret are all required.');
  const blob = JSON.stringify({ tenantId, clientId, clientSecret, fromMailbox: fromMailbox || DEFAULT_FROM });
  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, blob);
  return { ok: true };
}

// Mint (and cache) an app-only Graph token via the client_credentials flow.
async function _getAccessToken(cfg) {
  const now = Date.now();
  if (_accessToken && now < (_expiresAt - 60000)) return _accessToken;
  const form = 'grant_type=client_credentials'
    + '&client_id=' + encodeURIComponent(cfg.clientId)
    + '&client_secret=' + encodeURIComponent(cfg.clientSecret)
    + '&scope=' + encodeURIComponent('https://graph.microsoft.com/.default');
  const r = await _httpsPost(LOGIN_HOST, '/' + cfg.tenantId + '/oauth2/v2.0/token',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, form);
  if (r.status !== 200) throw new Error('Microsoft Graph token request failed: HTTP ' + r.status + ' — ' + r.body.slice(0, 400));
  const d = JSON.parse(r.body);
  _accessToken = d.access_token;
  _expiresAt = now + (d.expires_in * 1000);
  return _accessToken;
}

function _splitAddrs(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v).split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

// Send an email. opts: { to, cc, subject, body, html (bool), attachments:[{filename, content:Buffer, contentType}] }
// Returns { ok:true, sentTo } on success; throws on failure.
async function sendMail(keytar, opts) {
  const cfg = await getEmailConfig(keytar);
  const token = await _getAccessToken(cfg);

  const toList = _splitAddrs(opts.to);
  const ccList = _splitAddrs(opts.cc);
  if (!toList.length) throw new Error('No recipients provided.');

  let bodyContent = opts.body || '';
  const attachmentsPayload = [];
  for (const a of (opts.attachments || [])) {
    if (!a || !a.content) continue;
    const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content);
    if (buf.length <= INLINE_ATTACHMENT_LIMIT_BYTES) {
      attachmentsPayload.push({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.filename || 'attachment',
        contentType: a.contentType || 'application/octet-stream',
        contentBytes: buf.toString('base64'),
      });
    } else {
      bodyContent += '\n\n(Note: attachment ' + (a.filename || 'file') + ' is '
        + (buf.length / 1048576).toFixed(1) + ' MB, over the email attachment limit, so it was omitted.)\n';
    }
  }

  const message = {
    subject: opts.subject || '(no subject)',
    body: { contentType: opts.html ? 'HTML' : 'Text', content: opts.html ? (opts.body || '') : bodyContent },
    toRecipients: toList.map(a => ({ emailAddress: { address: a } })),
  };
  if (ccList.length) message.ccRecipients = ccList.map(a => ({ emailAddress: { address: a } }));
  if (attachmentsPayload.length) message.attachments = attachmentsPayload;

  const payload = JSON.stringify({ message, saveToSentItems: true });
  const r = await _httpsPost(GRAPH_HOST, '/v1.0/users/' + encodeURIComponent(cfg.fromMailbox) + '/sendMail',
    { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, payload);
  if (r.status !== 202) throw new Error('Microsoft Graph sendMail failed: HTTP ' + r.status + ' — ' + r.body.slice(0, 500));
  return { ok: true, sentTo: toList };
}

// ── RUN-NOTIFICATION EMAIL BUILDER ───────────────────────────────────────────
// Builds the { subject, html } for a scheduled-run notification. Matches the approved
// mockup: "BUU AUTOMATED RUN" header (green on success, red on failure), run summary,
// a "What failed" callout on failure, and the full step trail table.
function _esc(v){ return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _fmtDate(ts, tz){ try{ return new Intl.DateTimeFormat('en-US',{ timeZone:tz||'America/New_York', month:'short', day:'2-digit', year:'numeric' }).format(new Date(ts)); }catch(e){ return new Date(ts).toDateString(); } }
function _fmtTime(ts, tz, withSec){ try{ return new Intl.DateTimeFormat('en-US',{ timeZone:tz||'America/New_York', hour:'numeric', minute:'2-digit', second: withSec?'2-digit':undefined, hour12:true }).format(new Date(ts)); }catch(e){ return new Date(ts).toLocaleTimeString(); } }
function _fmtDur(ms){ if(ms==null) return '—'; const s=ms/1000; return s<10 ? s.toFixed(1)+'s' : Math.round(s)+'s'; }

// data: { flowName, frequencyPhrase, scheduleTimeLabel, tz, startTs, endTs, ok, err, total,
//         trail:[{n,label,status,ms,error}], errorText, poolId, recipients }
function buildRunEmail(data){
  const d = data || {};
  const tz = d.tz || 'America/New_York';
  const success = (parseInt(d.err,10) || 0) === 0;
  const displayFlow = String(d.flowName||'Flow').replace(/-flow$/i,'').trim() || 'Flow';
  const freq = d.frequencyPhrase || 'once';
  const endTs = d.endTs || Date.now();
  const startTs = d.startTs || endTs;
  const dateStr = _fmtDate(endTs, tz);
  const timeStr = _fmtTime(endTs, tz, false);

  const subject = (success ? 'Success! ' : 'Failure! ')
    + displayFlow + ' scheduled ' + freq
    + (success ? ' — completed on ' : ' — failed on ') + dateStr + ' at ' + timeStr;

  // Combined trail: login (ok) + data steps + logout (ok on success, skipped on failure).
  const dataTrail = Array.isArray(d.trail) ? d.trail : [];
  const combined = [];
  combined.push({ label:'Log in to PestPac', status:'ok', ms:null });
  for(const s of dataTrail){ combined.push({ label:s.label, status:s.status, ms:s.ms, error:s.error }); }
  combined.push({ label:'Log out of PestPac', status: success?'ok':'skipped', ms:null });

  // Identify the failing step for the callout.
  const failed = dataTrail.find(s => s.status === 'failed');
  const failLabel = failed ? failed.label : null;
  const failErr = (failed && failed.error) || d.errorText || 'The run reported an error.';
  const failStepNo = failed ? (combined.findIndex(x => x.label===failed.label && x.status==='failed') + 1) : null;

  const accent = success ? '#128a4b' : '#c0392b';
  const okBadge = '<span style="color:#128a4b;font-weight:700;font-size:12px;">ok</span>';
  const skipBadge = '<span style="color:#b6bcc6;font-weight:600;font-size:12px;">skipped</span>';
  const failBadge = '<span style="background:#c0392b;color:#ffffff;font-weight:700;font-size:11px;padding:2px 8px;border-radius:12px;">FAILED</span>';

  const rows = combined.map((s, idx) => {
    const n = idx + 1;
    const isFail = s.status === 'failed';
    const isSkip = s.status === 'skipped';
    const rowBg = isFail ? 'background:#fdf3f2;' : '';
    const brd = isFail ? '#f3d3ce' : '#f0f1f4';
    const numCol = isFail ? '#c0392b;font-weight:700' : '#98a2b3';
    const labelCol = isFail ? '#c0392b;font-weight:700' : (isSkip ? '#98a2b3' : '#101828');
    const badge = isFail ? failBadge : (isSkip ? skipBadge : okBadge);
    const timeCol = isFail ? '#c0392b' : (isSkip ? '#c8cdd5' : '#98a2b3');
    const timeVal = isSkip ? '—' : _fmtDur(s.ms);
    return '<tr style="'+rowBg+'">'
      + '<td style="padding:7px 10px;color:'+numCol+';border-top:1px solid '+brd+';">'+n+'</td>'
      + '<td style="padding:7px 10px;color:'+labelCol+';border-top:1px solid '+brd+';">'+_esc(s.label)+'</td>'
      + '<td style="padding:7px 10px;text-align:right;border-top:1px solid '+brd+';">'+badge+'</td>'
      + '<td style="padding:7px 12px;text-align:right;color:'+timeCol+';font-family:Consolas,Menlo,monospace;font-size:12px;border-top:1px solid '+brd+';">'+timeVal+'</td>'
      + '</tr>';
  }).join('');

  const resultPill = success
    ? '<span style="display:inline-block;background:#e7f4ec;color:#128a4b;font-weight:700;font-size:12px;padding:3px 10px;border-radius:20px;">'+(d.ok||0)+' of '+(d.total||1)+' completed &middot; 0 errors</span>'
    : '<span style="display:inline-block;background:#fbeae8;color:#c0392b;font-weight:700;font-size:12px;padding:3px 10px;border-radius:20px;">'+(d.ok||0)+' of '+(d.total||1)+' completed &middot; '+(d.err||0)+' error'+((d.err||0)===1?'':'s')+'</span>';

  const whatFailed = success ? '' : (
    '<tr><td style="padding:14px 28px 4px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fdf3f2;border:1px solid #f3d3ce;border-left:4px solid #c0392b;border-radius:8px;"><tr><td style="padding:12px 14px;">'
    + '<div style="font-size:11px;font-weight:700;color:#c0392b;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">What failed</div>'
    + (failLabel ? '<div style="font-size:13px;color:#101828;font-weight:600;margin-bottom:4px;">Step '+(failStepNo||'?')+' — '+_esc(failLabel)+'</div>' : '')
    + '<div style="font-size:12px;color:#6b3a34;font-family:Consolas,Menlo,monospace;line-height:1.5;">'+_esc(failErr)+'</div>'
    + '</td></tr></table></td></tr>'
  );

  const html =
'<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>'
+'<body style="margin:0;padding:24px 12px;background:#eceef1;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933;">'
+'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e5e9;border-radius:12px;overflow:hidden;">'
+'<tr><td style="background:'+accent+';padding:20px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
+'<td style="font-size:20px;font-weight:700;color:#ffffff;">'+(success?'&#10003;':'&#10007;')+'&nbsp; '+(success?'Success':'Failure')+'</td>'
+'<td align="right" style="font-size:12px;font-weight:600;color:'+(success?'#bfe6cd':'#f2c4bd')+';letter-spacing:.06em;text-transform:uppercase;">BUU Automated Run</td>'
+'</tr></table></td></tr>'
+'<tr><td style="padding:24px 28px 4px;"><div style="font-size:18px;font-weight:700;color:#101828;">'+_esc(displayFlow)+(success?' completed successfully':' failed')+'</div>'
+'<div style="font-size:13px;color:#667085;margin-top:3px;">Scheduled '+_esc(freq)+' &middot; '+(success?'completed ':'failed ')+_esc(dateStr)+' at '+_esc(timeStr)+'</div></td></tr>'
+'<tr><td style="padding:16px 28px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse;">'
+'<tr><td style="padding:6px 0;color:#667085;width:120px;">Flow</td><td style="padding:6px 0;color:#101828;font-weight:600;">'+_esc(displayFlow)+'</td></tr>'
+'<tr><td style="padding:6px 0;color:#667085;">Schedule</td><td style="padding:6px 0;color:#101828;">'+_esc((d.scheduleTimeLabel? (freq.charAt(0).toUpperCase()+freq.slice(1)+' at '+d.scheduleTimeLabel) : freq))+' &nbsp;<span style="color:#98a2b3;">('+_esc(tz)+')</span></td></tr>'
+'<tr><td style="padding:6px 0;color:#667085;">Started</td><td style="padding:6px 0;color:#101828;">'+_esc(_fmtDate(startTs,tz))+' &nbsp;'+_esc(_fmtTime(startTs,tz,true))+'</td></tr>'
+'<tr><td style="padding:6px 0;color:#667085;">Finished</td><td style="padding:6px 0;color:#101828;">'+_esc(_fmtDate(endTs,tz))+' &nbsp;'+_esc(_fmtTime(endTs,tz,true))+'</td></tr>'
+'<tr><td style="padding:6px 0;color:#667085;">Duration</td><td style="padding:6px 0;color:#101828;">'+_fmtDur(endTs-startTs)+'</td></tr>'
+'<tr><td style="padding:6px 0;color:#667085;">Result</td><td style="padding:6px 0;">'+resultPill+'</td></tr>'
+'</table></td></tr>'
+ whatFailed
+'<tr><td style="padding:18px 28px 6px;"><div style="font-size:11px;font-weight:700;color:#8a94a2;letter-spacing:.09em;text-transform:uppercase;margin-bottom:8px;">Step log</div>'
+'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse;border:1px solid #eef0f2;border-radius:8px;overflow:hidden;">'
+'<tr style="background:#f7f8fa;"><td style="padding:8px 10px;color:#8a94a2;font-weight:600;font-size:11px;width:28px;">#</td><td style="padding:8px 10px;color:#8a94a2;font-weight:600;font-size:11px;">Step</td><td style="padding:8px 10px;color:#8a94a2;font-weight:600;font-size:11px;text-align:right;">Status</td><td style="padding:8px 12px;color:#8a94a2;font-weight:600;font-size:11px;text-align:right;width:56px;">Time</td></tr>'
+ rows
+'</table></td></tr>'
+'<tr><td style="padding:16px 28px 22px;"><div style="border-top:1px solid #eef0f2;padding-top:12px;font-size:11px;color:#98a2b3;">BUU automated notification'+(d.poolId?(' &middot; pool run '+_esc(d.poolId)):'')+(d.recipients?(' &middot; sent to '+_esc(d.recipients)):'')+'</div></td></tr>'
+'</table></body></html>';

  return { subject, html };
}

module.exports = { sendMail, getEmailConfig, setEmailConfig, buildRunEmail, DEFAULT_FROM };
