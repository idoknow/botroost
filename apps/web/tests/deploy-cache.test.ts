import {describe,expect,it} from 'bun:test';

const nginx=await Bun.file(new URL('../../../deploy/nginx.conf',import.meta.url)).text();

describe('web deployment cache policy',()=>{
 it('revalidates the SPA shell while keeping fingerprinted assets immutable',()=>{
  expect(nginx).toMatch(/map \$uri \$botroost_cache_control[\s\S]*default[^\n]*no-cache[^\n]*no-store/);
  expect(nginx).toMatch(/map \$uri \$botroost_cache_control[\s\S]*~\^\/assets\/[^\n]*immutable/);
  expect(nginx).toContain('add_header Cache-Control $botroost_cache_control always;');
 });
});
