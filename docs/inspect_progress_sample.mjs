import fs from 'fs';
import path from 'path';

const p = path.join(process.cwd(), 'projects', '[迷男]_红楼遗秘_', 'pipeline_progress.json');
const data = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('pipeline_progress keys:', Object.keys(data));
console.log('pipeline_progress sample:', JSON.stringify(data).slice(0, 500));
