import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync('illustrator_config.json', 'utf8'));

fs.writeFileSync('docs/current_prompt_tags.txt', cfg.system_prompt_advanced_prompt || '', 'utf8');
fs.writeFileSync('docs/current_prompt_nl.txt', cfg.system_prompt_advanced_prompt_nl || '', 'utf8');

console.log('Saved current_prompt_tags.txt and current_prompt_nl.txt');
