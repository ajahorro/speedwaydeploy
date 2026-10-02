import assert from 'node:assert/strict';
import fs from 'node:fs';

const photoService = fs.readFileSync('frontend/src/services/photoService.js', 'utf8');
const gallery = fs.readFileSync('frontend/src/components/Photos/PhotoProofGallery.jsx', 'utf8');
const uploader = fs.readFileSync('frontend/src/components/Photos/PhotoProofUploader.jsx', 'utf8');
const staffDashboard = fs.readFileSync('frontend/src/pages/Staff/StaffDashboard.jsx', 'utf8');
const backend = fs.readFileSync('backend/server.js', 'utf8');
const staffTasksRoute = backend.slice(
  backend.indexOf("app.get('/api/staff/tasks'"),
  backend.indexOf("app.post('/api/bookings/reconcile-payment-state'")
);

const checks = [
  ['large service photos are resized and compressed', /MAX_IMAGE_EDGE = 1920/.test(photoService) && /canvasToBlob\(canvas, 'image\/jpeg', 0\.82\)/.test(photoService)],
  ['unsupported image optimization keeps the original file', /catch \{\s*return file;\s*\}/.test(photoService) && /uploading the original file/.test(photoService)],
  ['photo preparation and uploads are limited to pairs', /index \+= 2[\s\S]*?Promise\.all\(photoFiles\.slice\(index, index \+ 2\)\.map\(optimizeServicePhoto\)\)[\s\S]*?Promise\.allSettled\(batch\.map/.test(photoService)],
  ['photo URLs are signed in one batch', /createSignedUrls\(paths, SIGNED_URL_TTL_SECONDS\)/.test(photoService)],
  ['gallery supports mobile swipe and keyboard navigation', /onTouchEnd=/.test(gallery) && /ArrowLeft/.test(gallery) && /ArrowRight/.test(gallery)],
  ['uploader viewer supports mobile swipe and keyboard navigation', /onTouchEnd=/.test(uploader) && /ArrowLeft/.test(uploader) && /ArrowRight/.test(uploader)],
  ['staff task endpoint returns only fields used by the workflow', !/\.select\(\s*`[\s\S]*?\*/.test(staffTasksRoute) && !/customer:profiles/.test(staffTasksRoute) && /service_name/.test(staffTasksRoute)],
  ['staff dashboard no longer expects omitted customer details', !/customer:\s*b\.customer/.test(staffDashboard)],
  ['staff announcements fetch only displayed fields', /\.from\('notifications'\)\s*\.select\('title, message, created_at'\)/.test(staffDashboard)]
];

for (const [name, passed] of checks) {
  assert.ok(passed, name);
  console.log(`PASS  ${name}`);
}

console.log(`\n${checks.length} photo performance checks passed.`);
