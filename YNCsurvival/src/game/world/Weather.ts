import { DEPTH } from '../config';
import { Lighting } from './Lighting';

export type WeatherKind = 'rain' | 'snow' | 'storm' | 'fog' | 'night' | 'clear';

const DEPTH_WEATHER = DEPTH.projectile + 1;     //  어둠 위에 그려서 빛 밖에서도 보임
const NIGHT_DELTA = 0.1;        //  밤: 어둠이 이만큼 짙어짐
const CLEAR_DELTA = -0.2;       //  맑음: 어둠이 이만큼 옅어짐
const FOG_LIGHT_FACTOR = 0.7;   //  안개: 빛 반경 배율

//  시청자 이벤트 change_weather 연출
//  - 비 / 눈 / 폭풍: 화면에 고정된 입자 효과 (폭풍은 번개 섬광 추가)
//  - 안개: 회색 막 + 빛 반경 축소 / 밤·맑음: 어둠 짙기를 잠시 바꿈
//  - 최종 보스(긴 밤)가 어둠을 조절하는 동안에는 어둠 짙기를 건드리지 않는다
export class Weather
{
    private emitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
    private fog: Phaser.GameObjects.Rectangle | null = null;
    private lightning: Phaser.Time.TimerEvent | null = null;
    private endTimer: Phaser.Time.TimerEvent | null = null;
    private darknessDelta = 0;
    current: WeatherKind | null = null;

    constructor (private scene: Phaser.Scene, private lighting: Lighting, private darknessLocked: () => boolean)
    {
        createWeatherTextures(scene);
    }

    apply (kind: WeatherKind, durationMs: number)
    {
        this.clear();
        this.current = kind;
        const { width, height } = this.scene.scale;

        switch (kind)
        {
            case 'rain':
            case 'storm':
                this.emitter = this.scene.add.particles(0, -20, 'sdRain', {
                    x: { min: -100, max: width + 100 },
                    speedY: { min: 650, max: 850 },
                    speedX: { min: -140, max: -100 },
                    lifespan: 1300,
                    quantity: kind === 'storm' ? 6 : 3,
                    frequency: 25,
                    alpha: { start: 0.8, end: 0.3 },
                    rotate: 10
                });
                if (kind === 'storm')
                {
                    this.lightning = this.scene.time.addEvent({
                        delay: 2600, loop: true,
                        callback: () => this.scene.cameras.main.flash(120, 210, 220, 255)
                    });
                }
                break;
            case 'snow':
                this.emitter = this.scene.add.particles(0, -20, 'sdSnow', {
                    x: { min: -50, max: width + 50 },
                    speedY: { min: 60, max: 120 },
                    speedX: { min: -40, max: 40 },
                    lifespan: 9000,
                    quantity: 2,
                    frequency: 60,
                    scale: { min: 0.6, max: 1.3 },
                    alpha: { start: 0.9, end: 0.3 }
                });
                break;
            case 'fog':
                this.fog = this.scene.add.rectangle(0, 0, width, height, 0x9e9ab8, 0)
                    .setOrigin(0).setScrollFactor(0).setDepth(DEPTH_WEATHER);
                this.scene.tweens.add({ targets: this.fog, fillAlpha: 0.22, duration: 1500 });
                this.lighting.applyAsh(FOG_LIGHT_FACTOR, durationMs);
                break;
            case 'night':
                this.shiftDarkness(NIGHT_DELTA);
                break;
            case 'clear':
                this.shiftDarkness(CLEAR_DELTA);
                break;
        }

        this.emitter?.setScrollFactor(0).setDepth(DEPTH_WEATHER);
        this.endTimer = this.scene.time.delayedCall(durationMs, () => this.clear());
    }

    private shiftDarkness (delta: number)
    {
        if (this.darknessLocked())
        {
            return;
        }
        this.darknessDelta = delta;
        this.lighting.fadeDarkness(Phaser.Math.Clamp(this.lighting.darkness + delta, 0.3, 0.97), 1500);
    }

    clear ()
    {
        this.endTimer?.remove();
        this.lightning?.remove();
        this.emitter?.destroy();
        if (this.fog)
        {
            const fog = this.fog;
            this.scene.tweens.add({ targets: fog, fillAlpha: 0, duration: 1000, onComplete: () => fog.destroy() });
        }
        if (this.darknessDelta !== 0 && !this.darknessLocked())
        {
            this.lighting.fadeDarkness(Phaser.Math.Clamp(this.lighting.darkness - this.darknessDelta, 0.3, 0.97), 1500);
        }
        this.emitter = null;
        this.fog = null;
        this.lightning = null;
        this.endTimer = null;
        this.darknessDelta = 0;
        this.current = null;
    }
}

function createWeatherTextures (scene: Phaser.Scene)
{
    if (!scene.textures.exists('sdRain'))
    {
        const g = scene.make.graphics({}, false);
        g.fillStyle(0xaec6ff, 1).fillRect(0, 0, 2, 14);
        g.generateTexture('sdRain', 2, 14);
        g.destroy();
    }
    if (!scene.textures.exists('sdSnow'))
    {
        const g = scene.make.graphics({}, false);
        g.fillStyle(0xffffff, 1).fillCircle(3, 3, 3);
        g.generateTexture('sdSnow', 6, 6);
        g.destroy();
    }
}
