import { artScale } from '../display';
import { DEPTH, XP, xpToNextLevel } from '../config';
import { Player } from '../entities/Player';

type Sprite = Phaser.Physics.Arcade.Sprite;

//  경험치 불씨 드롭 / 흡수 / 레벨 계산 (텍스처 키는 gem / gemBig)
//  불씨는 어둠 위에 그려져서 빛 밖에서도 반짝인다
export class Experience
{
    level = 1;
    xp = 0;
    private gems: Phaser.Physics.Arcade.Group;

    constructor (
        private scene: Phaser.Scene,
        private player: Player,
        private onLevelUp: () => void
    )
    {
        this.gems = scene.physics.add.group({ maxSize: XP.maxGems });
    }

    get xpToNext (): number
    {
        return xpToNextLevel(this.level);
    }

    dropGem (x: number, y: number, value: number): Sprite | null
    {
        const texture = value >= 10 ? 'gemBig' : 'gem';
        const gem = this.gems.get(x, y, texture) as Sprite | null;
        if (!gem)
        {
            return null;    //  바닥에 불씨가 너무 많음
        }

        gem.setTexture(texture);    //  풀에서 재사용된 보석은 이전 텍스처가 남아 있을 수 있음
        gem.enableBody(true, x, y, true, true);
        gem.setData('value', value);
        gem.setDepth(DEPTH.embers).setScale(artScale());
        return gem;
    }

    //  나방 여왕 처치 시: 날개에서 불씨가 쏟아짐 (경험치 1짜리 count 개를 주변에 흩뿌림)
    burst (x: number, y: number, count: number)
    {
        for (let i = 0; i < count; i++)
        {
            const gem = this.dropGem(x, y, 1);
            if (!gem)
            {
                return;
            }
            const angle = Math.random() * Math.PI * 2;
            const dist = 30 + Math.random() * 90;
            this.scene.tweens.add({
                targets: gem,
                x: x + Math.cos(angle) * dist,
                y: y + Math.sin(angle) * dist,
                duration: 400 + Math.random() * 300,
                ease: 'Cubic.easeOut'
            });
        }
    }

    update ()
    {
        const magnetSq = XP.magnetRadius * XP.magnetRadius;
        const despawnSq = XP.despawnDistance * XP.despawnDistance;
        const collectSq = XP.collectRadius * XP.collectRadius;

        for (const obj of this.gems.getChildren())
        {
            const gem = obj as Sprite;
            if (!gem.active)
            {
                continue;
            }

            const distSq = Phaser.Math.Distance.Squared(gem.x, gem.y, this.player.x, this.player.y);
            if (distSq <= collectSq)
            {
                gem.disableBody(true, true);
                this.gain(gem.getData('value') as number);
            }
            else if (distSq <= magnetSq)
            {
                this.scene.physics.moveToObject(gem, this.player, XP.pullSpeed);
            }
            else if (distSq > despawnSq)
            {
                gem.disableBody(true, true);    //  맵이 끝없으므로 너무 멀리 남겨진 불씨는 정리
            }
            else
            {
                gem.setVelocity(0, 0);
            }
        }
    }

    gain (amount: number)
    {
        this.xp += amount;
        while (this.xp >= this.xpToNext)
        {
            this.xp -= this.xpToNext;
            this.level++;
            this.onLevelUp();
        }
    }
}
