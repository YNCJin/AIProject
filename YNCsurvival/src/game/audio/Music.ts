//  메인 BGM 「마지막 등불」: 음원 파일 없이 Web Audio 로 실시간 연주
//  D 단조, 84 BPM. 패드(화음) + 베이스 + 오르골 아르페지오 + 멜로디 + 심장 박동 같은 북
//  구성: 도입 4마디 -> A(8) -> B(8) -> A(8) -> B(8) -> A 부터 반복 (한 바퀴 약 1분 40초)

const BPM = 84;
const BEAT = 60 / BPM;
const STEP = BEAT / 2;          //  8분음표 단위로 진행
const STEPS_PER_BAR = 8;
const LOOKAHEAD_S = 0.2;        //  이만큼 앞의 음까지 미리 예약
const TICK_MS = 50;

type ChordName = 'Dm' | 'Bb' | 'F' | 'C' | 'Gm' | 'A' | 'Am';

//  [베이스 음, 화음 구성음 3개] (MIDI 번호, 60 = 가운데 도)
const CHORDS: Record<ChordName, { bass: number; tones: number[] }> = {
    Dm: { bass: 38, tones: [62, 65, 69] },
    Bb: { bass: 46, tones: [62, 65, 70] },
    F:  { bass: 41, tones: [60, 65, 69] },
    C:  { bass: 36, tones: [60, 64, 67] },
    Gm: { bass: 43, tones: [62, 67, 70] },
    A:  { bass: 45, tones: [61, 64, 69] },
    Am: { bass: 45, tones: [60, 64, 69] },
};

//  멜로디: 마디마다 [음, 박자 길이] (null = 쉼표), 한 마디 = 4박
type Note = [number | null, number];

const THEME_A: { chord: ChordName; melody: Note[] }[] = [
    { chord: 'Dm', melody: [[69, 1.5], [70, 0.5], [69, 1], [65, 1]] },
    { chord: 'Bb', melody: [[62, 2], [65, 1], [67, 1]] },
    { chord: 'F',  melody: [[69, 1.5], [72, 0.5], [70, 1], [69, 1]] },
    { chord: 'C',  melody: [[67, 3], [null, 1]] },
    { chord: 'Dm', melody: [[69, 1.5], [70, 0.5], [69, 1], [74, 1]] },
    { chord: 'Bb', melody: [[72, 1.5], [70, 0.5], [69, 1], [67, 1]] },
    { chord: 'Gm', melody: [[65, 1], [67, 1], [70, 1], [69, 1]] },
    { chord: 'A',  melody: [[69, 3], [null, 1]] },
];

const THEME_B: { chord: ChordName; melody: Note[] }[] = [
    { chord: 'Bb', melody: [[74, 1.5], [72, 0.5], [70, 1], [74, 1]] },
    { chord: 'C',  melody: [[76, 2], [72, 1], [67, 1]] },
    { chord: 'Am', melody: [[72, 1.5], [74, 0.5], [76, 1], [72, 1]] },
    { chord: 'Dm', melody: [[74, 3], [null, 1]] },
    { chord: 'Gm', melody: [[70, 1], [74, 1], [79, 1.5], [77, 0.5]] },
    { chord: 'C',  melody: [[76, 1.5], [74, 0.5], [72, 1], [76, 1]] },
    { chord: 'F',  melody: [[77, 1], [76, 1], [74, 1], [72, 1]] },
    { chord: 'A',  melody: [[73, 2], [69, 2]] },
];

interface Bar
{
    chord: ChordName;
    melody: Note[] | null;
    drums: boolean;
}

const INTRO: Bar[] = (['Dm', 'Bb', 'F', 'A'] as ChordName[]).map((chord) => ({ chord, melody: null, drums: false }));
const section = (theme: typeof THEME_A, drums: boolean): Bar[] => theme.map((bar) => ({ ...bar, drums }));

const SONG: Bar[] = [
    ...INTRO,
    ...section(THEME_A, false),
    ...section(THEME_B, true),
    ...section(THEME_A, true),
    ...section(THEME_B, true),
];
const LOOP_START_BAR = INTRO.length;

const ARP_PATTERN = [0, 1, 2, 3, 2, 1, 3, 1];   //  화음 구성음 순서 (3 = 첫 음의 한 옥타브 위)

const freq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

export class Music
{
    private bus: GainNode;
    private timer: number | null = null;
    private bar = 0;
    private step = 0;
    private nextTime = 0;

    constructor (private ctx: AudioContext, output: AudioNode, reverb: AudioNode)
    {
        this.bus = ctx.createGain();
        this.bus.gain.value = 0;
        this.bus.connect(output);

        const wet = ctx.createGain();
        wet.gain.value = 0.45;
        this.bus.connect(wet).connect(reverb);
    }

    get playing (): boolean
    {
        return this.timer !== null;
    }

    start (fadeS = 2)
    {
        if (this.playing)
        {
            return;
        }
        this.bar = 0;
        this.step = 0;
        this.nextTime = this.ctx.currentTime + 0.1;
        this.fadeTo(1, fadeS);
        this.timer = window.setInterval(() => this.schedule(), TICK_MS);
        this.schedule();
    }

    stop (fadeS = 1.5)
    {
        if (!this.playing)
        {
            return;
        }
        window.clearInterval(this.timer!);
        this.timer = null;
        this.fadeTo(0, fadeS);
    }

    private fadeTo (value: number, seconds: number)
    {
        const g = this.bus.gain;
        const now = this.ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(value, now + Math.max(0.01, seconds));
    }

    //  다음 LOOKAHEAD_S 초 안에 울릴 음들을 미리 예약
    private schedule ()
    {
        const now = this.ctx.currentTime;
        //  탭이 백그라운드에 있다가 돌아오면 밀린 음을 몰아서 내지 않고 지금부터 이어서 연주
        if (this.nextTime < now - 0.1)
        {
            this.nextTime = now + 0.05;
        }

        while (this.nextTime < now + LOOKAHEAD_S)
        {
            this.playStep(SONG[this.bar], this.step, this.nextTime);

            this.nextTime += STEP;
            this.step++;
            if (this.step >= STEPS_PER_BAR)
            {
                this.step = 0;
                this.bar = this.bar + 1 >= SONG.length ? LOOP_START_BAR : this.bar + 1;
            }
        }
    }

    private playStep (bar: Bar, step: number, t: number)
    {
        const chord = CHORDS[bar.chord];

        if (step === 0)
        {
            this.pad(chord.tones, t, BEAT * 4);
            if (bar.melody)
            {
                let offset = 0;
                for (const [note, beats] of bar.melody)
                {
                    if (note !== null)
                    {
                        this.lead(note, t + offset * BEAT, beats * BEAT);
                    }
                    offset += beats;
                }
            }
        }

        if (step === 0 || step === 4)
        {
            this.bass(chord.bass, t, BEAT * 2);
        }

        const arpTones = [...chord.tones, chord.tones[0] + 12];
        this.bell(arpTones[ARP_PATTERN[step]] + 12, t, step % 2 === 0 ? 0.05 : 0.035);

        if (bar.drums)
        {
            //  심장 박동처럼 "쿵-쿵" (1박, 1박 반), 3박째에 한 번 더
            if (step === 0 || step === 4) this.kick(t, 0.5);
            if (step === 1) this.kick(t, 0.28);
            if (step % 2 === 1) this.shaker(t, step === 3 || step === 7 ? 0.05 : 0.03);
        }
    }

    // ---------------------------------------------------------------- 악기

    private envelope (t: number, peak: number, attack: number, hold: number, release: number): GainNode
    {
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + attack);
        g.gain.setValueAtTime(peak, t + attack + hold);
        g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
        g.connect(this.bus);
        return g;
    }

    //  어두운 밤공기 같은 화음: 살짝 어긋나게 조율한 톱니파 두 개를 저역 필터로 둥글게
    private pad (tones: number[], t: number, length: number)
    {
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 900;
        filter.Q.value = 0.5;
        filter.connect(this.envelope(t, 0.045, 0.8, length - 0.8, 1.2));

        for (const tone of tones)
        {
            for (const detune of [-7, 7])
            {
                const osc = this.ctx.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.value = freq(tone - 12);
                osc.detune.value = detune;
                osc.connect(filter);
                osc.start(t);
                osc.stop(t + length + 1.3);
            }
        }
    }

    private bass (note: number, t: number, length: number)
    {
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq(note);
        osc.connect(this.envelope(t, 0.22, 0.03, length * 0.6, length * 0.5));
        osc.start(t);
        osc.stop(t + length * 1.2);
    }

    //  오르골 소리: 사인파 + 금속성 배음, 빠르게 사그라듦
    private bell (note: number, t: number, volume: number)
    {
        const out = this.envelope(t, volume, 0.005, 0, 1.4);
        for (const [ratio, level] of [[1, 1], [2.76, 0.25], [5.4, 0.08]])
        {
            const osc = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            osc.frequency.value = freq(note) * ratio;
            g.gain.value = level;
            osc.connect(g).connect(out);
            osc.start(t);
            osc.stop(t + 1.5);
        }
    }

    //  멜로디: 플루트처럼 부드러운 삼각파 + 약간의 떨림(비브라토)
    private lead (note: number, t: number, length: number)
    {
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq(note);

        const vibrato = this.ctx.createOscillator();
        const depth = this.ctx.createGain();
        vibrato.frequency.value = 5;
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(freq(note) * 0.006, t + Math.min(0.5, length));
        vibrato.connect(depth).connect(osc.frequency);

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 2400;
        filter.connect(this.envelope(t, 0.13, 0.06, Math.max(0, length - 0.2), 0.45));
        osc.connect(filter);

        const end = t + length + 0.6;
        osc.start(t);
        vibrato.start(t);
        osc.stop(end);
        vibrato.stop(end);
    }

    private kick (t: number, volume: number)
    {
        const osc = this.ctx.createOscillator();
        osc.frequency.setValueAtTime(110, t);
        osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
        osc.connect(this.envelope(t, volume, 0.005, 0.02, 0.3));
        osc.start(t);
        osc.stop(t + 0.4);
    }

    private shaker (t: number, volume: number)
    {
        const src = this.ctx.createBufferSource();
        src.buffer = noiseBuffer(this.ctx);
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 6500;
        src.connect(filter).connect(this.envelope(t, volume, 0.01, 0, 0.08));
        src.start(t, Math.random() * 0.5, 0.15);
    }
}

//  백색 소음 1초 (효과음과 공용, 한 번만 만든다)
let noise: AudioBuffer | null = null;
export function noiseBuffer (ctx: BaseAudioContext): AudioBuffer
{
    if (!noise || noise.sampleRate !== ctx.sampleRate)
    {
        noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < data.length; i++)
        {
            data[i] = Math.random() * 2 - 1;
        }
    }
    return noise;
}
