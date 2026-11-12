import { Music, noiseBuffer } from './Music';

//  게임 전체 소리 담당 (BGM + 효과음). 음원 파일 없이 Web Audio 로 직접 합성한다
//  사용: import { sound } from '../audio/Sound';  sound.play('hit');
//  브라우저는 사용자가 클릭/키 입력을 하기 전에는 소리를 막으므로 첫 입력 때 자동으로 켜진다

export type SfxName =
    | 'emberShot'     //  불씨 탄 발사
    | 'aura'          //  등불의 온기가 적을 태움
    | 'poolCast'      //  불씨 웅덩이 생성
    | 'poolIgnite'    //  불씨 웅덩이 폭발
    | 'hit'           //  일반 몬스터 피격
    | 'bossHit'       //  보스 피격
    | 'kill';         //  일반 몬스터 처치

const VOLUME = { master: 0.8, music: 0.5, sfx: 0.55 };
const MUTE_KEY = 'lastLantern.muted';

//  같은 소리가 한 프레임에 수십 번 겹치지 않도록 최소 간격(초)
const MIN_GAP: Record<SfxName, number> = {
    emberShot: 0.07,
    aura: 0.3,
    poolCast: 0.1,
    poolIgnite: 0.08,
    hit: 0.04,
    bossHit: 0.09,
    kill: 0.05,
};

class SoundSystem
{
    private ctx: AudioContext | null = null;
    private master!: GainNode;
    private sfxBus!: GainNode;
    private music: Music | null = null;
    private lastPlayed: Partial<Record<SfxName, number>> = {};
    private wantMusic = false;
    muted = loadMuted();

    //  첫 사용자 입력에서 오디오를 깨우고, M 키로 소리 켜기/끄기
    install ()
    {
        const unlock = () => this.context()?.resume();
        window.addEventListener('pointerdown', unlock);
        window.addEventListener('keydown', (e) => {
            unlock();
            if (e.code === 'KeyM' && !e.repeat)
            {
                this.toggleMute();
            }
        });
    }

    toggleMute (): boolean
    {
        this.muted = !this.muted;
        try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch { /* 저장 불가 환경 */ }
        if (this.ctx)
        {
            this.master.gain.setTargetAtTime(this.muted ? 0 : VOLUME.master, this.ctx.currentTime, 0.05);
        }
        return this.muted;
    }

    startMusic ()
    {
        this.wantMusic = true;
        const ctx = this.context();
        if (ctx)
        {
            this.music!.start();
        }
    }

    stopMusic (fadeS = 1.5)
    {
        this.wantMusic = false;
        this.music?.stop(fadeS);
    }

    play (name: SfxName)
    {
        const ctx = this.context();
        if (!ctx || ctx.state !== 'running' || this.muted)
        {
            return;
        }
        const t = ctx.currentTime;
        if (t - (this.lastPlayed[name] ?? -1) < MIN_GAP[name])
        {
            return;
        }
        this.lastPlayed[name] = t;
        SFX[name](new Voice(ctx, this.sfxBus, t));
    }

    private context (): AudioContext | null
    {
        if (this.ctx)
        {
            return this.ctx;
        }
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor)
        {
            return null;
        }

        const ctx = new Ctor();
        this.ctx = ctx;

        //  큰 소리가 겹쳐도 찢어지지 않도록 마지막에 컴프레서
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 4;
        comp.connect(ctx.destination);

        this.master = ctx.createGain();
        this.master.gain.value = this.muted ? 0 : VOLUME.master;
        this.master.connect(comp);

        const reverb = ctx.createConvolver();
        reverb.buffer = impulse(ctx, 2.8);
        reverb.connect(this.master);

        const musicBus = ctx.createGain();
        musicBus.gain.value = VOLUME.music;
        musicBus.connect(this.master);
        const reverbIn = ctx.createGain();
        reverbIn.connect(reverb);
        this.music = new Music(ctx, musicBus, reverbIn);

        this.sfxBus = ctx.createGain();
        this.sfxBus.gain.value = VOLUME.sfx;
        this.sfxBus.connect(this.master);
        const sfxWet = ctx.createGain();
        sfxWet.gain.value = 0.12;
        this.sfxBus.connect(sfxWet).connect(reverbIn);

        if (this.wantMusic)
        {
            this.music.start();
        }
        return ctx;
    }
}

//  효과음 하나를 만드는 도우미: 발진기/소음 + 필터 + 볼륨 곡선
class Voice
{
    constructor (private ctx: AudioContext, private out: AudioNode, readonly t: number)
    {
    }

    //  볼륨 곡선: 빠르게 올라갔다가 decay 초 동안 사라짐
    env (peak: number, attack: number, decay: number, delay = 0): GainNode
    {
        const t = this.t + delay;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
        g.connect(this.out);
        return g;
    }

    //  from -> to 로 음높이가 미끄러지는 발진기
    tone (type: OscillatorType, from: number, to: number, slide: number, dest: AudioNode, length: number, delay = 0)
    {
        const t = this.t + delay;
        const osc = this.ctx.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(from, t);
        osc.frequency.exponentialRampToValueAtTime(to, t + slide);
        osc.connect(dest);
        osc.start(t);
        osc.stop(t + length);
    }

    //  필터를 거친 소음 (불길, 바람, 타격의 '퍽' 소리)
    noise (type: BiquadFilterType, from: number, to: number, q: number, dest: AudioNode, length: number, delay = 0)
    {
        const t = this.t + delay;
        const src = this.ctx.createBufferSource();
        src.buffer = noiseBuffer(this.ctx);
        const filter = this.ctx.createBiquadFilter();
        filter.type = type;
        filter.Q.value = q;
        filter.frequency.setValueAtTime(from, t);
        filter.frequency.exponentialRampToValueAtTime(to, t + length);
        src.connect(filter).connect(dest);
        src.start(t, Math.random() * 0.5, length);
    }
}

const vary = (value: number, amount = 0.08) => value * (1 + (Math.random() * 2 - 1) * amount);

const SFX: Record<SfxName, (v: Voice) => void> = {
    //  "슉": 불씨가 튀어나가는 짧은 바람 소리 + 작게 올라가는 음
    emberShot: (v) => {
        v.noise('bandpass', 1800, 4200, 1.2, v.env(0.22, 0.005, 0.09), 0.1);
        v.tone('triangle', vary(620), vary(1250), 0.06, v.env(0.07, 0.003, 0.07), 0.09);
    },

    //  "우웅": 등불이 따뜻하게 숨쉬는 낮은 화음 + 숨결 같은 소음
    aura: (v) => {
        const body = v.env(0.12, 0.04, 0.5);
        v.tone('sine', 220, 196, 0.5, body, 0.6);
        v.tone('sine', 330, 294, 0.5, body, 0.6);
        v.noise('lowpass', 1400, 300, 0.7, v.env(0.08, 0.03, 0.35), 0.45);
    },

    //  "스으": 바닥에 불씨가 모이는 상승음
    poolCast: (v) => {
        v.noise('bandpass', 400, 1600, 2, v.env(0.12, 0.12, 0.2), 0.35);
        v.tone('sine', vary(330), vary(520), 0.3, v.env(0.04, 0.1, 0.2), 0.35);
    },

    //  "화르륵 쿵": 웅덩이가 터지는 불길 + 낮은 충격음
    poolIgnite: (v) => {
        v.noise('lowpass', 3500, 250, 0.8, v.env(0.32, 0.01, 0.45), 0.5);
        v.tone('sine', 120, 45, 0.25, v.env(0.35, 0.005, 0.3), 0.35);
        v.noise('bandpass', 5000, 2000, 3, v.env(0.06, 0.02, 0.3, 0.05), 0.35, 0.05);
    },

    //  "툭": 짐승을 때리는 짧고 둔탁한 소리, 매번 음높이가 살짝 다름
    hit: (v) => {
        v.tone('sine', vary(240, 0.12), 90, 0.07, v.env(0.3, 0.002, 0.08), 0.1);
        v.noise('highpass', 2200, 1200, 0.7, v.env(0.1, 0.001, 0.025), 0.04);
    },

    //  "쾅": 보스 피격, 더 묵직하고 금속성 울림
    bossHit: (v) => {
        v.tone('sine', vary(150, 0.06), 55, 0.12, v.env(0.38, 0.002, 0.16), 0.2);
        v.tone('square', vary(520, 0.05), 380, 0.1, v.env(0.04, 0.002, 0.12), 0.15);
        v.noise('bandpass', 1500, 600, 1.5, v.env(0.15, 0.001, 0.07), 0.1);
    },

    //  "푸스스": 짐승이 재가 되어 흩어짐
    kill: (v) => {
        v.noise('bandpass', 1200, 400, 1, v.env(0.16, 0.005, 0.22), 0.25);
        v.tone('sine', vary(880, 0.1), vary(1320, 0.1), 0.08, v.env(0.03, 0.005, 0.15), 0.18);
    },
};

//  잔향(리버브)용 임펄스: 점점 작아지는 스테레오 소음
function impulse (ctx: AudioContext, seconds: number): AudioBuffer
{
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++)
    {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < length; i++)
        {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
        }
    }
    return buffer;
}

function loadMuted (): boolean
{
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

export const sound = new SoundSystem();
