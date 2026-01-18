/**
 * Test to confirm CommonMark spec behavior for nested fences
 */
import { Parser, Language } from 'web-tree-sitter';

async function main() {
    await Parser.init();

    const parser = new Parser();
    const markdownLang = await Language.load('./demo/svelte-demo/static/tree-sitter-markdown.wasm');
    parser.setLanguage(markdownLang);

    console.log('=== TEST 1: Invalid markdown (3-backtick nested in 3-backtick) ===');
    console.log('According to CommonMark spec, the FIRST ``` closes the block.\n');

    const invalid = `
\`\`\`markdown
\`\`\`python
def hello():
    pass
\`\`\`
\`\`\`

### Horizontal Rules
`;

    let tree = parser.parse(invalid);
    let headers = tree.rootNode.descendantsOfType('atx_heading');
    let codeBlocks = tree.rootNode.descendantsOfType('fenced_code_block');

    console.log(`Code blocks: ${codeBlocks.length}`);
    console.log(`Headers: ${headers.length}`);
    if (headers.length === 0) {
        console.log('❌ "### Horizontal Rules" NOT detected as header (expected per spec)');
    }

    console.log('\n=== TEST 2: VALID markdown (4-backtick outer fence) ===');
    console.log('Using ```` (4 backticks) for outer fence allows ``` inside.\n');

    const valid = `
\`\`\`\`markdown
\`\`\`python
def hello():
    pass
\`\`\`
\`\`\`\`

### Horizontal Rules
`;

    tree = parser.parse(valid);
    headers = tree.rootNode.descendantsOfType('atx_heading');
    codeBlocks = tree.rootNode.descendantsOfType('fenced_code_block');

    console.log(`Code blocks: ${codeBlocks.length}`);
    console.log(`Headers: ${headers.length}`);
    if (headers.length > 0) {
        console.log('✅ "### Horizontal Rules" correctly detected as header!');
    }

    console.log('\n=== CONCLUSION ===');
    console.log('Tree-sitter is following CommonMark spec correctly.');
    console.log('The LLM output uses INVALID markdown (3-backtick nested in 3-backtick).');
    console.log('Proper markdown requires outer fence to have MORE backticks than inner.');
}

main().catch(console.error);
