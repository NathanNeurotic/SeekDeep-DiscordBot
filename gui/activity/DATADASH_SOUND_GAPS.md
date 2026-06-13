# DataDash Sound Gaps

This inventory separates events that are completely silent from events that
currently borrow another event's clip. Suggested keys follow the existing
`DATADASH.SOUNDS.files` naming style.

## Completely Silent

| Category | Event | Suggested key |
|---|---|---|
| UI | Pause | `pause` |
| UI | Resume | `resume` |
| UI | Controls panel opens | `uiOpen` |
| UI | Controls panel closes | `uiClose` |
| UI | A run sets a new personal best | `newBest` |
| Weapon | Charge cancelled before the minimum charge | `chargeCancel` |
| Weapon | Shot or charged shot rejected for insufficient DATA | `dryFire` |
| Combat | Normal player projectile hits a boss | `bossHit` |
| Combat | Nonlethal projectile hit on mini-malware | `malwareHit` |
| Combat | Boss bomb actually detonates (`bossBomb` currently fires when it is deployed) | `bossBombExplode` |
| Death | Mini-malware expires after its chase distance | `malwareExpire` |
| Death | DDoS mini-malware scrolls out of the event lane | `malwareDespawn` |
| Death | Boss body finishes its crash into the floor/offscreen | `bossCrash` |
| Despawn | Any uncollected pickup scrolls offscreen | `pickupMiss` |
| State | Fast mystery effect expires | `speedEnd` |
| State | Slow mystery effect expires | `slowEnd` |
| State | Reverse mystery effect expires | `reverseEnd` |
| State | Pepe invincibility expires | `invincibleEnd` |
| State | Over Clocked transformation sequence finishes | `overclockReady` |
| Event | DATA Base event completes | `databaseClear` |
| Event | DDoS event completes | `ddosClear` |
| Event | Overclock Cache event completes | `overclockCacheClear` |
| Boss | Boss finishes entering and the fight becomes active | `bossEngage` |
| Boss | Final boss is removed and normal music/gameplay resumes | `bossClear` |
| Spawn | Normal kernel pickup appears | `kernelSpawn` |
| Spawn | Emergency kernel pack appears | `bonusSpawn` |
| Spawn | Mystery pickup appears | `mysterySpawn` |
| Spawn | DATA packet or packet string appears | `packetSpawn` |
| Spawn | Over Clocked upgrade appears | `upgradeSpawn` |
| Spawn | Pepe jackpot coin appears | `pepeSpawn` |
| Spawn | DATA LOSS pickup appears | `dataLossSpawn` |
| Spawn | DATA RECOVERY pickup appears | `dataRecoverySpawn` |
| Spawn | Shield pickup appears | `shieldSpawn` |
| Spawn | A new DDoS malware column enters during the event | `ddosWaveSpawn` |

## Reusing A Shared Clip

These events make a sound, but do not yet have their own sonic identity.

| Event | Current clip | Suggested dedicated key |
|---|---|---|
| Emergency kernel pack collected | `kernel` | `bonusPickup` |
| Over Clocked upgrade collected | `powerUp` | `overclockStart` |
| Event-gift Over Clocked upgrade collected | `powerUp` | `overclockRefresh` |
| DATA RECOVERY collected | `powerUp` | `dataRecovery` |
| DATA LOSS collected | `damage` | `dataLoss` |
| Reroute/restart begins | `jackIn` | `restart` |
| Shield pickup collected | `shieldHeld` | `shieldOnline` |
| Shield absorbs a hit and breaks | `shieldHeld` | `shieldBreak` |
| First Over Clocked absorbed hit | `shieldHeld` | `overclockHit` |
| Reverse mystery effect begins | `mystery` | `reverseStart` |
| DATA Base event begins | `packet` | `databaseStart` |
| Overclock Cache event begins | `powerUp` | `overclockCacheStart` |
| Double-boss event begins | `bossIncoming` | `doubleBossIncoming` |
| Wall collision costs a kernel | `damage` | `wallHit` |
| Boss body collision costs a kernel | `damage` | `bossContact` |
| Boss projectile costs a kernel | `damage` | `bossBulletHit` |
| Boss bomb blast costs a kernel | `damage` | `bossBombHit` |
| Mini-malware contact costs a kernel | `damage` | `malwareContact` |

## Already Dedicated

Game start, normal shot, charge loop, charged-shot release, firewall smash,
normal kernel pickup, DATA packet pickup, speed-up activation, slow-down
activation, Over Clocked power-down, Pepe pickup/invincibility loop,
mini-malware spawn/presence/death, general damage, game over, boss warning,
boss music, boss fire, boss-bomb deployment, and boss defeat already have
mapped clips.
