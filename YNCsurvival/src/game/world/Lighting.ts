import { ART_SCALE, SCREEN } from '../display';
import { PALETTE } from '../art/Textures';
import { DEPTH, LIGHT } from '../config';

const MASK_SIZE = 256 * ART_SCALE;     //  lightMask 텍스처 크기
const RADIUS_LERP = 0.12;       //  빛 반경이 바뀔 때 부드럽게 따라가는 정도

//  어둠과 등불 시야
//  - 화면 크기의 어둠 막(RenderTexture)을 매 프레임 칠하고, 등불 위치에 둥근 구멍을 지운다
//  - 어둠 막보다 아래(depth)에 있는 짐승은 빛 밖에서 거의 안 보이고, 위에 있는 눈 / 불씨 / 보스는 보인다
//  - 등불의 온기(무기)는 bonusRadius 로 빛을 넓히고, 나방 여왕의 재 가루는 잠시 빛을 좁힌다
export class Lighting
{
    baseRadius = LIGHT.baseRadius;
    bonusRadius = 0;
    darkness = LIGHT.darkness;      //  tween 으로 바꿀 수 있음

    private ashUntil = 0;
    private ashFactor = 1;
    private shownRadius = LIGHT.baseRadius;
    private now = 0;

    private overlay: Phaser.GameObjects.RenderTexture;
    private mask: Phaser.GameObjects.Image;
    private glow: Phaser.GameObjects.Image;

    constructor (private scene: Phaser.Scene)
    {
        const { width, height } = SCREEN;

        this.overlay = scene.add.renderTexture(0, 0, width, height)
            .setOrigin(0).setScrollFactor(0).setDepth(DEPTH.darkness);

        //  화면에 직접 그리지 않고 어둠 막에서 지우는 용도로만 사용
        this.mask = scene.make.image({ key: 'lightMask' }, false).setOrigin(0.5);

        //  등불 주변 바닥을 따뜻하게 물들이는 빛
        this.glow = scene.add.image(0, 0, 'lanternGlow')
            .setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.lanternGlow);
    }

    //  현재 빛 반경 (재 가루 효과 포함)
    get radius (): number
    {
        const ash = this.now < this.ashUntil ? this.ashFactor : 1;
        return (this.baseRadius + this.bonusRadius) * ash;
    }

    //  나방 여왕의 재 가루: ms 동안 빛 반경을 factor 배로
    applyAsh (factor: number, ms: number)
    {
        this.ashFactor = factor;
        this.ashUntil = Math.max(this.ashUntil, this.now + ms);
    }

    //  어둠 짙기를 ms 에 걸쳐 바꿈
    fadeDarkness (to: number, ms: number)
    {
        this.scene.tweens.add({ targets: this, darkness: to, duration: ms });
    }

    //  등불의 온기가 피해를 줄 때 빛이 한 번 일렁임
    pulse ()
    {
        this.scene.tweens.add({ targets: this.glow, alpha: { from: 1.6, to: 1 }, duration: 300 });
    }

    //  now: 게임 경과 시간 / (x, y): 등불 월드 좌표 / (viewX, viewY): 화면 왼쪽 위 월드 좌표
    update (now: number, x: number, y: number, viewX: number, viewY: number)
    {
        this.now = now;
        this.shownRadius += (this.radius - this.shownRadius) * RADIUS_LERP;

        //  빛 구멍: lightMask 는 중심 55% 까지 완전히 밝고 가장자리로 갈수록 어두워짐
        const scale = (this.shownRadius * 2) / MASK_SIZE;
        this.mask.setScale(scale);

        this.overlay.clear();
        this.overlay.fill(PALETTE.darkness, this.darkness);
        this.overlay.erase(this.mask, x - viewX, y - viewY);

        this.glow.setPosition(x, y).setScale(scale * 1.1);
    }
}
