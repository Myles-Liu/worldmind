/**
 * Test Classic Text Domain
 * 
 * 演示：孙子兵法 → 职场场景剧本生成
 */

import { createClassicTextAdapter } from '../src/domains/classic-text/index.js';

async function main() {
  console.log('🎭 Classic Text Domain 测试\n');
  console.log('━'.repeat(60));
  
  const adapter = createClassicTextAdapter();
  
  // 孙子兵法 · 谋攻篇
  const request = {
    sourceText: '不战而屈人之兵，善之善者也。故上兵伐谋，其次伐交，其次伐兵，其下攻城。',
    sourceBook: '孙子兵法',
    sourceChapter: '谋攻篇',
    sceneType: 'workplace' as const,
    customSceneDescription: '员工想说服老板批准50万AI项目预算',
  };
  
  console.log('\n📜 原文:', request.sourceText);
  console.log('📚 出处:', `${request.sourceBook} · ${request.sourceChapter}`);
  console.log('🎬 场景:', request.sceneType);
  console.log('\n生成中...\n');
  
  try {
    const result = await adapter.dramatizeText(request);
    
    console.log('━'.repeat(60));
    console.log('\n📋 生成的剧本:\n');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('❌ 错误:', error);
  }
}

main();
