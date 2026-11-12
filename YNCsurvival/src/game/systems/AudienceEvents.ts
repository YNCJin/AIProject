import type { Game } from '../scenes/Game';
import type { AudienceEvent } from '../net/StreamDirectorClient';
import { DEPTH } from '../config';
import { BeastOptions } from './EnemySpawner';
import { Weather, WeatherKind } from '../world/Weather';

const BANNER_MS = 2600;
const SPAWN_STAGGER_MS = 45;            //  몹을 한꺼번에 찍지 않고 조금씩 나눠 소환
const ITEM_SCATTER = 140;               //  아이템이 떨어지는 플레이어 주변 반경
const BOMB_RANGE_FACTOR = 1.6;          //  폭탄: 빛 반경의 이 배수 안 짐승 처치
const MAX_EMBER_BURST = 60;

//  몹 종류별 강화 (서버 variant: normal / fast / tank / ranged / swarm)
const BEAST_VARIANTS: Record<string, BeastOptions & { countMult?: number }> = {
    normal: {},
    fast: { kind: 'wolf', speedMult: 1.35 },
    tank: { kind: 'wolf', hpMult: 3, scale: 1.35, speedMult: 0.8 },
    ranged: { kind: 'wolf', speedMult: 1.15 },      //  원거리 짐승이 없어 빠른 늑대로 대체
    swarm: { kind: 'dog', hpMult: 0.6, scale: 0.85, countMult: 1.5 },
};

//  시청자(채팅 투표 / 후원)가 만든 AI 이벤트를 게임 시스템에 적용한다
//  이벤트 규격: StreamDirector docs/game_integration.md (값 범위는 서버가 이미 클램핑해서 보냄)
export class AudienceEvents
{
    readonly weather: Weather;
    applied = 0;
    private bannerText: Phaser.GameObjects.Text | null = null;

    constructor (private game: Game)
    {
        this.weather = new Weather(game, game.lighting, () => !!game.bosses.finalBoss);
    }

    apply (ev: AudienceEvent)
    {
        if (this.game.isGameOver)
        {
            return;
        }

        const durationMs = Math.max(1, ev.duration_sec) * 1000;
        let ok = true;

        switch (ev.event_type)
        {
            case 'spawn_enemies':
                ok = this.spawnEnemies(ev);
                break;
            case 'spawn_boss':
                ok = this.spawnBoss(ev);
                break;
            case 'heal_player':
                this.heal(this.game.stats.maxHp * 0.1 * ev.intensity);
                break;
            case 'buff_player':
                this.buff(ev.variant, ev.intensity, durationMs);
                break;
            case 'debuff_player':
                this.debuff(ev.variant, durationMs);
                break;
            case 'drop_item':
                this.dropItems(ev.variant, Math.max(1, ev.count), ev.intensity);
                break;
            case 'change_weather':
                this.weather.apply(ev.variant as WeatherKind, durationMs);
                break;
            case 'enemy_speed':
                this.temporary(this.game.enemies, 'speedMultiplier', ev.variant === 'slow' ? 0.55 : 1.5, durationMs);
                break;
            default:
                return;
        }

        if (ok)
        {
            this.applied++;
            this.banner(ev);
        }
    }

    // ---------------------------------------------------------------- 몹 / 보스

    private spawnEnemies (ev: AudienceEvent): boolean
    {
        const game = this.game;
        if (game.bosses.finalBoss || !game.enemies.spawning)
        {
            game.announce('긴 밤이 짐승을 거둬갔다', '#b0bec5');
            return false;
        }
        const variant = BEAST_VARIANTS[ev.variant] ?? BEAST_VARIANTS.normal;
        const count = Math.round(Math.max(1, ev.count) * (variant.countMult ?? 1));
        const options: BeastOptions = {
            ...variant,
            hpMult: (variant.hpMult ?? 1) * (1 + 0.15 * (ev.intensity - 1))
        };
        for (let i = 0; i < count; i++)
        {
            game.time.delayedCall(i * SPAWN_STAGGER_MS, () => game.enemies.spawnAroundPlayer(game.elapsedMs, options));
        }
        return true;
    }

    private spawnBoss (ev: AudienceEvent): boolean
    {
        const game = this.game;
        //  후원으로 발동되면 후원 전용 보스(재의 나방 여왕), 채팅 투표면 밀랍 순례자
        if (ev.source === 'donation' && ev.donation_amount)
        {
            const before = game.bosses.group.countActive(true);
            game.onDonation(ev.donation_amount, ev.donor ?? undefined);
            return game.bosses.group.countActive(true) > before;
        }
        if (!game.bosses.spawnPilgrim())
        {
            game.announce('지금은 순례자를 부를 수 없음', '#b0bec5');
            return false;
        }
        return true;
    }

    // ---------------------------------------------------------------- 플레이어

    private heal (amount: number)
    {
        this.game.player.heal(Math.round(amount));
        this.floatText(`+${Math.round(amount)}`, '#81c784');
    }

    private buff (variant: string, intensity: number, durationMs: number)
    {
        const { stats, player } = this.game;
        switch (variant)
        {
            case 'attack':
                this.temporary(stats, 'tempDamageMultiplier', 1.3 + 0.1 * intensity, durationMs);
                break;
            case 'speed':
                this.temporary(stats, 'tempSpeedMultiplier', 1.25 + 0.05 * intensity, durationMs);
                break;
            case 'shield':
            case 'invincible':
            {
                const ms = variant === 'shield' ? Math.min(durationMs, 5000) : durationMs;
                player.invulnUntil = Math.max(player.invulnUntil, this.game.time.now + ms);
                player.setTint(0xffe082);
                this.game.time.delayedCall(ms, () => player.clearTint());
                break;
            }
            case 'regen':
                this.game.time.addEvent({
                    delay: 1000, repeat: Math.max(0, Math.floor(durationMs / 1000) - 1),
                    callback: () => this.heal(2 + intensity)
                });
                break;
        }
    }

    private debuff (variant: string, durationMs: number)
    {
        const game = this.game;
        switch (variant)
        {
            case 'slow':
                game.player.applyEffects({ slowFactor: 0.6, slowMs: durationMs });
                break;
            case 'blind':
                game.lighting.applyAsh(0.55, durationMs);
                break;
            case 'weak':
            case 'no_regen':
            default:
                this.temporary(game.stats, 'tempDamageMultiplier', 0.6, durationMs);
                break;
        }
    }

    // ---------------------------------------------------------------- 아이템

    private dropItems (variant: string, count: number, intensity: number)
    {
        const game = this.game;
        const kinds = ['chest', 'potion', 'weapon', 'bomb'];
        for (let i = 0; i < count; i++)
        {
            const kind = variant === 'random' || !kinds.includes(variant) ? Phaser.Utils.Array.GetRandom(kinds) : variant;
            const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
            const dist = Phaser.Math.FloatBetween(40, ITEM_SCATTER);
            const x = game.player.x + Math.cos(angle) * dist;
            const y = game.player.y + Math.sin(angle) * dist;

            switch (kind)
            {
                case 'chest':       //  불씨 상자: 경험치 불씨가 쏟아짐
                    game.experience.burst(x, y, Math.min(MAX_EMBER_BURST, 8 + intensity * 4));
                    break;
                case 'potion':
                    this.heal(15 + intensity * 3);
                    break;
                case 'weapon':      //  무기 강화 상자: 즉시 레벨업 (카드 선택)
                    game.experience.gain(Math.max(1, game.experience.xpToNext - game.experience.xp));
                    break;
                case 'bomb':
                    this.bomb();
                    break;
            }
        }
    }

    private bomb ()
    {
        const game = this.game;
        const range = game.lighting.radius * BOMB_RANGE_FACTOR;
        const rangeSq = range * range;
        for (const enemy of [...game.enemies.activeEnemies()])
        {
            if (Phaser.Math.Distance.Squared(enemy.x, enemy.y, game.player.x, game.player.y) <= rangeSq)
            {
                game.enemies.damage(enemy, 99999);
            }
        }
        game.cameras.main.flash(250, 255, 210, 140);
    }

    // ---------------------------------------------------------------- 공통

    //  배율을 잠시 곱했다가 시간이 지나면 되돌림 (겹쳐도 순서와 상관없이 원래 값으로 돌아옴)
    private temporary<T extends object, K extends keyof T> (target: T, key: K, factor: number, durationMs: number)
    {
        (target[key] as unknown as number) = (target[key] as unknown as number) * factor;
        this.game.time.delayedCall(durationMs, () => {
            (target[key] as unknown as number) = (target[key] as unknown as number) / factor;
        });
    }

    private floatText (content: string, color: string)
    {
        const game = this.game;
        const text = game.add.text(game.player.x, game.player.y - 40, content, {
            fontFamily: 'Arial Black', fontSize: 22, color, stroke: '#000000', strokeThickness: 5
        }).setOrigin(0.5).setDepth(DEPTH.announce);
        game.tweens.add({ targets: text, y: text.y - 40, alpha: 0, duration: 1000, onComplete: () => text.destroy() });
    }

    //  화면 위쪽 시청자 이벤트 알림: AI 문구 + 누가 발동했는지
    private banner (ev: AudienceEvent)
    {
        const game = this.game;
        const who = ev.source === 'donation'
            ? `${ev.donor ?? '익명'}님의 후원${ev.donation_amount ? ` ${ev.donation_amount.toLocaleString()}원` : ''}`
            : `시청자 ${ev.supporters}명의 선택 (${Math.round(ev.vote_share * 100)}%)`;
        //  이벤트가 연달아 오면 이전 알림을 지우고 새 알림만 표시 (겹쳐서 읽기 어려워지지 않도록)
        if (this.bannerText)
        {
            game.tweens.killTweensOf(this.bannerText);
            this.bannerText.destroy();
        }
        const text = game.add.text(game.scale.width / 2, 92, `${ev.overlay_text}\n${who}`, {
            fontFamily: 'Arial Black', fontSize: 22, color: ev.source === 'donation' ? '#ffd27a' : '#e1bee7',
            align: 'center', stroke: '#000000', strokeThickness: 6, lineSpacing: 4
        }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(DEPTH.announce);
        this.bannerText = text;
        game.tweens.add({
            targets: text, alpha: 0, delay: BANNER_MS, duration: 500, onComplete: () => {
                text.destroy();
                if (this.bannerText === text) this.bannerText = null;
            }
        });
    }

    destroy ()
    {
        this.weather.clear();
    }
}
