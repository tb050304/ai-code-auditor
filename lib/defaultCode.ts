/**
 * 编辑器默认示例代码。
 * 如需在不改动源码的前提下自定义默认内容，
 * 可设置环境变量 NEXT_PUBLIC_DEFAULT_CODE 覆盖默认值。
 */
export const DEFAULT_CODE: string =
  process.env.NEXT_PUBLIC_DEFAULT_CODE ||
  `// 请输入需要审计的 JavaScript/TypeScript 代码...

function calculate(a, b) {
  var result = a + b;
  return result
}`;