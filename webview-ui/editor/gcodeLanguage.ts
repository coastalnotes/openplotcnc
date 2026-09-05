import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

export const GCODE_LANGUAGE_ID = 'gcode';

let registered = false;

/** Register the G-code language, Monarch tokenizer and folding rules once. */
export function registerGcodeLanguage(): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: GCODE_LANGUAGE_ID });

  monaco.languages.setLanguageConfiguration(GCODE_LANGUAGE_ID, {
    comments: { lineComment: ';', blockComment: ['(', ')'] },
    brackets: [
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '[', close: ']' },
      { open: '(', close: ')' },
    ],
    folding: {
      markers: {
        start: /^\s*;\s*#?region\b/,
        end: /^\s*;\s*#?endregion\b/,
      },
    },
  });

  monaco.languages.setMonarchTokensProvider(GCODE_LANGUAGE_ID, {
    ignoreCase: true,
    defaultToken: '',
    tokenizer: {
      root: [
        [/^\s*\/\d?/, 'comment.block-delete'],
        [/\(/, { token: 'comment', next: '@paren' }],
        [/;.*$/, 'comment'],
        [/^\s*\$(?:PATH)?[1-4]\b/, 'keyword.channel'],
        [/![ ]*L?[ ]*\d+/, 'keyword.sync'],
        [/\bWAIT(?:CODE)?\b/, 'keyword.sync'],
        [/\bM1[0-9]{2}\b/, 'keyword.sync'],
        [/^\s*[O:]\d{1,5}\b/, 'type.identifier'],
        [/^\s*N\d+/, 'number.line'],
        [/G\d{1,3}(?:\.\d)?/, 'keyword.gcode'],
        [/M\d{1,3}/, 'keyword.mcode'],
        [/T\d{1,4}/, 'attribute.name.tool'],
        [/[XYZUVWABC](?=[-+.\d[])/, 'variable.axis'],
        [/[FSHDPQREIJK](?=[-+.\d[])/, 'attribute.name.param'],
        [/#\d+/, 'variable.macro'],
        [/[-+]?\d*\.?\d+/, 'number'],
        [/[[\]]/, 'delimiter.bracket'],
      ],
      paren: [
        [/[^()]+/, 'comment'],
        [/\(/, { token: 'comment', next: '@push' }],
        [/\)/, { token: 'comment', next: '@pop' }],
      ],
    },
  });

  // Colour tokens for both themes.
  const rules = (dark: boolean) => [
    { token: 'keyword.gcode', foreground: dark ? '4FC1FF' : '0000C0', fontStyle: 'bold' },
    { token: 'keyword.mcode', foreground: dark ? 'C586C0' : 'A000A0' },
    { token: 'keyword.sync', foreground: dark ? 'F59E0B' : 'B45309', fontStyle: 'bold' },
    { token: 'keyword.channel', foreground: dark ? '4EC9B0' : '267F99', fontStyle: 'bold' },
    { token: 'variable.axis', foreground: dark ? '9CDCFE' : '001080' },
    { token: 'attribute.name.param', foreground: dark ? 'DCDCAA' : '795E26' },
    { token: 'attribute.name.tool', foreground: dark ? '4EC9B0' : '267F99' },
    { token: 'number.line', foreground: dark ? '858585' : '999999' },
    { token: 'variable.macro', foreground: dark ? 'D7BA7D' : '8a6d00' },
    { token: 'comment.block-delete', foreground: dark ? '808080' : '999999', fontStyle: 'italic' },
  ];

  monaco.editor.defineTheme('opc-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: rules(true) as monaco.editor.ITokenThemeRule[],
    colors: {},
  });
  monaco.editor.defineTheme('opc-light', {
    base: 'vs',
    inherit: true,
    rules: rules(false) as monaco.editor.ITokenThemeRule[],
    colors: {},
  });
}
