import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { GCODE_LANGUAGE_ID, registerGcodeLanguage } from './gcodeLanguage';
import { parseMultiChannel } from '../../src/parser';
import { alignChannels, type AlignmentResult } from '../../src/channels/alignment';
import type { ChannelPayload, Dialect } from '../../src/types';

export interface MultiChannelOptions {
  onEdit: (channel: number, text: string) => void;
  onCursor: (channel: number, line: number) => void;
}

interface ChannelEditor {
  id: number;
  name: string;
  column: HTMLElement;
  editor: monaco.editor.IStandaloneCodeEditor;
  model: monaco.editor.ITextModel;
  viewZoneIds: string[];
  decorations: string[];
  execDecorations: string[];
}

export class MultiChannelEditor {
  private readonly editorsHost: HTMLElement;
  private channels: ChannelEditor[] = [];
  private dialect: Dialect = 'fanuc';
  private theme: 'light' | 'dark' = 'dark';
  private suppressScroll = false;
  private editDebounce: number | undefined;
  private alignment: AlignmentResult | undefined;

  constructor(root: HTMLElement, private readonly opts: MultiChannelOptions) {
    registerGcodeLanguage();
    this.editorsHost = document.createElement('div');
    this.editorsHost.className = 'mce-grid';
    root.appendChild(this.editorsHost);
    window.addEventListener('resize', () => this.layout());
  }

  get alignmentResult(): AlignmentResult | undefined {
    return this.alignment;
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.theme = theme;
    monaco.editor.setTheme(theme === 'light' ? 'opc-light' : 'opc-dark');
  }

  setChannels(channels: ChannelPayload[], dialect: Dialect): void {
    this.dialect = dialect;
    const wanted = channels.map((c) => c.id);

    // Drop editors no longer present.
    for (const ce of this.channels.filter((c) => !wanted.includes(c.id))) {
      ce.editor.dispose();
      ce.model.dispose();
      ce.column.remove();
    }
    this.channels = this.channels.filter((c) => wanted.includes(c.id));

    for (const payload of channels) {
      let ce = this.channels.find((c) => c.id === payload.id);
      if (!ce) {
        ce = this.createChannel(payload);
        this.channels.push(ce);
      } else {
        ce.name = payload.name;
        const label = ce.column.querySelector('.mce-title');
        if (label) label.textContent = payload.name;
        if (ce.model.getValue() !== payload.text) {
          // Preserve cursor / view state across a remote update.
          const view = ce.editor.saveViewState();
          ce.model.setValue(payload.text);
          if (view) ce.editor.restoreViewState(view);
        }
      }
    }

    this.channels.sort((a, b) => a.id - b.id);
    for (const ce of this.channels) this.editorsHost.appendChild(ce.column);
    this.editorsHost.style.gridTemplateColumns = `repeat(${this.channels.length}, minmax(0, 1fr))`;

    this.setTheme(this.theme);
    this.refreshAlignment();
    this.layout();
  }

  private createChannel(payload: ChannelPayload): ChannelEditor {
    const column = document.createElement('div');
    column.className = 'mce-col';

    const header = document.createElement('div');
    header.className = 'mce-header';
    const title = document.createElement('span');
    title.className = 'mce-title';
    title.textContent = payload.name;
    const badge = document.createElement('span');
    badge.className = 'mce-badge';
    badge.textContent = `CH${payload.id}`;
    badge.style.background = ['#22d3ee', '#f59e0b', '#e879f9', '#4ade80'][payload.id - 1] ?? '#888';
    header.append(badge, title);
    column.appendChild(header);

    const editorHost = document.createElement('div');
    editorHost.className = 'mce-editor';
    column.appendChild(editorHost);

    const model = monaco.editor.createModel(payload.text, GCODE_LANGUAGE_ID);
    const editor = monaco.editor.create(editorHost, {
      model,
      automaticLayout: false,
      minimap: { enabled: false },
      lineNumbers: 'on',
      folding: true,
      renderWhitespace: 'none',
      scrollBeyondLastLine: false,
      fontSize: 12,
      wordWrap: 'off',
      smoothScrolling: false,
      theme: this.theme === 'light' ? 'opc-light' : 'opc-dark',
    });

    const ce: ChannelEditor = {
      id: payload.id,
      name: payload.name,
      column,
      editor,
      model,
      viewZoneIds: [],
      decorations: [],
      execDecorations: [],
    };

    model.onDidChangeContent(() => {
      if (this.editDebounce) window.clearTimeout(this.editDebounce);
      this.editDebounce = window.setTimeout(() => {
        this.opts.onEdit(ce.id, model.getValue());
        this.refreshAlignment();
      }, 250);
    });

    editor.onDidScrollChange((e) => {
      if (this.suppressScroll) return;
      this.suppressScroll = true;
      for (const other of this.channels) {
        if (other === ce) continue;
        other.editor.setScrollTop(e.scrollTop);
      }
      this.suppressScroll = false;
    });

    editor.onDidChangeCursorPosition((e) => {
      this.opts.onCursor(ce.id, e.position.lineNumber - 1);
    });

    return ce;
  }

  private refreshAlignment(): void {
    if (this.channels.length < 2) {
      this.alignment = undefined;
      for (const ce of this.channels) this.applyViewZones(ce, []);
      return;
    }
    const program = parseMultiChannel(
      this.channels.map((c) => ({ channel: c.id, name: c.name, source: c.model.getValue() })),
      { dialect: this.dialect }
    );
    this.alignment = alignChannels(program);
    this.layoutAlignment();
  }

  /** Insert spacer view-zones so shared sync codes align row-for-row. */
  layoutAlignment(): void {
    const align = this.alignment;
    if (!align) return;

    for (const ce of this.channels) {
      const colIdx = align.channels.indexOf(ce.id);
      if (colIdx < 0) {
        this.applyViewZones(ce, []);
        continue;
      }
      const lineToRow = align.lineToRow.get(ce.id)!;
      const gaps: { afterLine: number; lines: number }[] = [];
      let prevRow = -1;
      const total = ce.model.getLineCount();
      for (let i = 0; i < total; i++) {
        const row = lineToRow.has(i) ? lineToRow.get(i)! : prevRow + 1;
        const gap = row - prevRow - 1;
        if (gap > 0) gaps.push({ afterLine: i, lines: gap }); // afterLineNumber = i (0-based line before)
        prevRow = row;
      }
      this.applyViewZones(ce, gaps);

      // Barrier highlight decorations.
      const decos: monaco.editor.IModelDeltaDecoration[] = [];
      for (const b of align.barriers) {
        const ln = b.participants.get(ce.id);
        if (ln === undefined) continue;
        decos.push({
          range: new monaco.Range(ln + 1, 1, ln + 1, 1),
          options: {
            isWholeLine: true,
            className: 'opc-sync-line',
            linesDecorationsClassName: 'opc-sync-margin',
            overviewRuler: {
              color: '#f59e0b',
              position: monaco.editor.OverviewRulerLane.Full,
            },
          },
        });
      }
      ce.decorations = ce.editor.deltaDecorations(ce.decorations, decos);
    }
  }

  private applyViewZones(ce: ChannelEditor, gaps: { afterLine: number; lines: number }[]): void {
    ce.editor.changeViewZones((accessor) => {
      for (const id of ce.viewZoneIds) accessor.removeZone(id);
      ce.viewZoneIds = [];
      for (const g of gaps) {
        const dom = document.createElement('div');
        dom.className = 'opc-spacer';
        ce.viewZoneIds.push(
          accessor.addZone({
            afterLineNumber: g.afterLine,
            heightInLines: g.lines,
            domNode: dom,
          })
        );
      }
    });
  }

  /** Highlight the line each channel is currently executing during playback. */
  highlightExecuting(state: Map<number, { line: number; waiting: boolean }>): void {
    for (const ce of this.channels) {
      const s = state.get(ce.id);
      if (!s) {
        ce.execDecorations = ce.editor.deltaDecorations(ce.execDecorations, []);
        continue;
      }
      ce.execDecorations = ce.editor.deltaDecorations(ce.execDecorations, [
        {
          range: new monaco.Range(s.line + 1, 1, s.line + 1, 1),
          options: {
            isWholeLine: true,
            className: s.waiting ? 'opc-exec-wait' : 'opc-exec-line',
          },
        },
      ]);
      ce.editor.revealLineInCenterIfOutsideViewport(s.line + 1);
    }
  }

  revealChannelLine(channel: number, line: number): void {
    const ce = this.channels.find((c) => c.id === channel);
    if (!ce) return;
    ce.editor.revealLineInCenter(line + 1);
    ce.editor.setPosition({ lineNumber: line + 1, column: 1 });
  }

  channelTexts(): { channel: number; name: string; source: string }[] {
    return this.channels.map((c) => ({
      channel: c.id,
      name: c.name,
      source: c.model.getValue(),
    }));
  }

  layout(): void {
    for (const ce of this.channels) ce.editor.layout();
  }

  dispose(): void {
    for (const ce of this.channels) {
      ce.editor.dispose();
      ce.model.dispose();
    }
    this.channels = [];
  }
}
