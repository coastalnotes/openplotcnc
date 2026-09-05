import type { SetupConfig, ToolDef, ToolType } from '../../src/types';
import { CHANNEL_COLORS } from '../../src/config/defaults';

const TOOL_TYPES: ToolType[] = [
  'od-turn',
  'id-bore',
  'part-off',
  'groove',
  'thread',
  'drill',
  'endmill-radial',
  'endmill-axial',
  'tap',
];

export class ConfigPanel {
  private setup: SetupConfig | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly onSave: (setup: SetupConfig) => void
  ) {
    this.host.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.act === 'close' || t === this.host) this.hide();
      if (t.dataset.act === 'save') this.save();
      if (t.dataset.act === 'add-tool') this.addToolRow();
      if (t.dataset.act === 'del-tool') t.closest('tr')?.remove();
    });
  }

  setSetup(setup: SetupConfig): void {
    this.setup = structuredClone(setup);
    if (!this.host.hidden) this.render();
  }

  show(): void {
    if (!this.setup) return;
    this.host.hidden = false;
    this.render();
  }

  hide(): void {
    this.host.hidden = true;
  }

  private render(): void {
    const s = this.setup!;
    const m = s.machine;
    this.host.innerHTML = `
    <div class="cfg-card" role="dialog" aria-label="Machine & Tooling Setup">
      <header>
        <h2>Machine &amp; Tooling Setup</h2>
        <button data-act="close" class="ghost">✕</button>
      </header>
      <div class="cfg-body">
        <section>
          <h3>Kinematics</h3>
          <label>Mode
            <select id="km">
              <option value="swiss-type"${m.kinematicsMode === 'swiss-type' ? ' selected' : ''}>Swiss-type (sliding headstock)</option>
              <option value="standard-lathe"${m.kinematicsMode === 'standard-lathe' ? ' selected' : ''}>Standard lathe</option>
            </select>
          </label>
          <label>Control dialect
            <select id="dialect">
              <option value="fanuc"${m.dialect === 'fanuc' ? ' selected' : ''}>Fanuc</option>
              <option value="mitsubishi"${m.dialect === 'mitsubishi' ? ' selected' : ''}>Mitsubishi</option>
            </select>
          </label>
          <label class="chk"><input type="checkbox" id="dia"${m.diameterMode ? ' checked' : ''}/> X values are diameters</label>
          <label>Units
            <select id="units">
              <option value="mm"${m.units === 'mm' ? ' selected' : ''}>mm</option>
              <option value="inch"${m.units === 'inch' ? ' selected' : ''}>inch</option>
            </select>
          </label>
          <label>Guide bushing Z <input type="number" id="gbz" value="${m.guideBushingZ}" step="1"/></label>
          <label>Main spindle face Z <input type="number" id="msz" value="${m.mainSpindleFaceZ}" step="1"/></label>
          <label class="chk"><input type="checkbox" id="subEn"${m.subSpindle.enabled ? ' checked' : ''}/> Sub-spindle enabled</label>
          <label>Sub home Z <input type="number" id="subHome" value="${m.subSpindle.homeZ}" step="1"/></label>
          <label>Sub pickup Z <input type="number" id="subPick" value="${m.subSpindle.pickupZ}" step="1"/></label>
        </section>

        <section>
          <h3>Bar Stock</h3>
          <label>Outer Ø <input type="number" id="od" value="${s.stock.outerDiameter}" step="0.1"/></label>
          <label>Inner Ø (tube) <input type="number" id="id" value="${s.stock.innerDiameter}" step="0.1"/></label>
          <label>Length <input type="number" id="len" value="${s.stock.length}" step="1"/></label>
          <label>Bushing protrusion <input type="number" id="pro" value="${s.stock.protrusion}" step="0.5"/></label>
          <label>Material <input type="text" id="mat" value="${s.stock.material ?? ''}"/></label>
        </section>

        <section>
          <h3>Channels</h3>
          <table class="cfg-table" id="chan-table">
            <thead><tr><th>#</th><th>Name</th><th>Spindle</th><th>Colour</th></tr></thead>
            <tbody>
              ${m.channels
                .map(
                  (c, i) => `<tr data-id="${c.id}">
                <td>${c.id}</td>
                <td><input type="text" value="${c.name}" data-f="name"/></td>
                <td><select data-f="spindle">
                  <option value="main"${c.spindle === 'main' ? ' selected' : ''}>main</option>
                  <option value="sub"${c.spindle === 'sub' ? ' selected' : ''}>sub</option>
                </select></td>
                <td><input type="color" value="${c.color ?? CHANNEL_COLORS[i]}" data-f="color"/></td>
              </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </section>

        <section class="wide">
          <h3>Tooling <button data-act="add-tool" class="ghost small">+ add</button></h3>
          <table class="cfg-table" id="tool-table">
            <thead><tr><th>ID</th><th>Ch</th><th>Station</th><th>Type</th><th>Orient</th><th>NoseR</th><th>Width</th><th>Ø</th><th></th></tr></thead>
            <tbody>
              ${s.tools.map((t) => this.toolRow(t)).join('')}
            </tbody>
          </table>
        </section>
      </div>
      <footer>
        <button data-act="close" class="ghost">Cancel</button>
        <button data-act="save" class="primary">Save setup</button>
      </footer>
    </div>`;
  }

  private toolRow(t: Partial<ToolDef>): string {
    return `<tr>
      <td><input type="text" data-f="id" value="${t.id ?? ''}"/></td>
      <td><input type="number" data-f="channel" min="1" max="4" value="${t.channel ?? 1}"/></td>
      <td><input type="text" data-f="station" value="${t.station ?? ''}"/></td>
      <td><select data-f="type">${TOOL_TYPES.map(
        (tt) => `<option value="${tt}"${t.type === tt ? ' selected' : ''}>${tt}</option>`
      ).join('')}</select></td>
      <td><select data-f="orientation">${['main', 'sub', 'radial', 'axial']
        .map((o) => `<option value="${o}"${t.orientation === o ? ' selected' : ''}>${o}</option>`)
        .join('')}</select></td>
      <td><input type="number" data-f="noseRadius" step="0.05" value="${t.noseRadius ?? ''}"/></td>
      <td><input type="number" data-f="width" step="0.1" value="${t.width ?? ''}"/></td>
      <td><input type="number" data-f="diameter" step="0.1" value="${t.diameter ?? ''}"/></td>
      <td><button data-act="del-tool" class="ghost small">✕</button></td>
    </tr>`;
  }

  private addToolRow(): void {
    const tbody = this.host.querySelector('#tool-table tbody');
    if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', this.toolRow({ id: `tool-${tbody.children.length + 1}`, channel: 1, type: 'od-turn', orientation: 'main' }));
  }

  private save(): void {
    if (!this.setup) return;
    const q = <T extends HTMLElement>(sel: string) => this.host.querySelector(sel) as T;
    const num = (sel: string, dflt: number) => {
      const v = Number(q<HTMLInputElement>(sel).value);
      return Number.isFinite(v) ? v : dflt;
    };
    const s = this.setup;
    s.machine.kinematicsMode = q<HTMLSelectElement>('#km').value as SetupConfig['machine']['kinematicsMode'];
    s.machine.dialect = q<HTMLSelectElement>('#dialect').value as SetupConfig['machine']['dialect'];
    s.machine.diameterMode = q<HTMLInputElement>('#dia').checked;
    s.machine.units = q<HTMLSelectElement>('#units').value as 'mm' | 'inch';
    s.machine.guideBushingZ = num('#gbz', 0);
    s.machine.mainSpindleFaceZ = num('#msz', -20);
    s.machine.subSpindle.enabled = q<HTMLInputElement>('#subEn').checked;
    s.machine.subSpindle.homeZ = num('#subHome', 260);
    s.machine.subSpindle.pickupZ = num('#subPick', 40);
    s.stock.outerDiameter = num('#od', 20);
    s.stock.innerDiameter = num('#id', 0);
    s.stock.length = num('#len', 300);
    s.stock.protrusion = num('#pro', 15);
    s.stock.material = q<HTMLInputElement>('#mat').value || undefined;

    s.machine.channels = [...this.host.querySelectorAll('#chan-table tbody tr')].map((tr, i) => ({
      id: Number(tr.getAttribute('data-id')) || i + 1,
      name: (tr.querySelector('[data-f="name"]') as HTMLInputElement).value || `Path ${i + 1}`,
      spindle: (tr.querySelector('[data-f="spindle"]') as HTMLSelectElement).value as 'main' | 'sub',
      color: (tr.querySelector('[data-f="color"]') as HTMLInputElement).value,
      file: s.machine.channels[i]?.file,
      marker: s.machine.channels[i]?.marker,
    }));

    s.tools = [...this.host.querySelectorAll('#tool-table tbody tr')].map((tr, i) => {
      const g = (f: string) => (tr.querySelector(`[data-f="${f}"]`) as HTMLInputElement | HTMLSelectElement)?.value ?? '';
      const optNum = (f: string) => {
        const v = Number(g(f));
        return g(f) !== '' && Number.isFinite(v) ? v : undefined;
      };
      return {
        id: g('id') || `tool-${i + 1}`,
        channel: Number(g('channel')) || 1,
        station: g('station'),
        type: g('type') as ToolType,
        orientation: g('orientation') as ToolDef['orientation'],
        noseRadius: optNum('noseRadius'),
        width: optNum('width'),
        diameter: optNum('diameter'),
      } satisfies ToolDef;
    });

    this.onSave(structuredClone(s));
    this.hide();
  }
}
