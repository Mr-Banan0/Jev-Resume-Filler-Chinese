import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const schema = readJson('../data/resume-schema.json');
const template = readJson('../data/resume-default.json');
const prompt = readFileSync(new URL('../prompts/resume-parse-prompt.md', import.meta.url), 'utf8');

for (const key of Object.keys(schema.properties)) {
  assert.ok(Object.hasOwn(template, key), `默认模板缺少顶层分区：${key}`);
}

const assertRecordContract = section => {
  const record = template[section][0];
  const fields = schema.properties[section].items.properties;
  for (const key of Object.keys(fields)) {
    assert.ok(Object.hasOwn(record, key), `默认模板缺少 ${section}[].${key}`);
  }
};

for (const section of ['education', 'internship', 'work']) assertRecordContract(section);
for (const key of Object.keys(schema.properties.application.properties)) {
  assert.ok(Object.hasOwn(template.application, key), `默认模板缺少 application.${key}`);
}
for (const section of ['application', 'campusPractice', 'publications', 'patents', 'family', 'training']) {
  assert.match(prompt, new RegExp(`\\\`${section}\\\``), `初始化提示词未说明 ${section}`);
}

console.log('schema, default template, and initialization prompt stay aligned');
