/**
 * SmartFlow AI — Decision Engine v2
 * Weighted scoring matrix with confidence levels and decision transparency.
 */

const ACTIONS = {
  CONTINUE:    'CONTINUE',
  REROUTE:     'REROUTE',
  SWITCH_MODE: 'SWITCH_MODE',
  DELAY:       'DELAY',
};

const MODE_EMOJI = {
  car: '🚗', bike: '🚲', bus: '🚌', metro: '🚇', walking: '🚶', scooter: '🛵',
};

const TRAFFIC_SCORE  = { low: 1, medium: 2, high: 3, extreme: 4 };
const URGENCY_SCORE  = { low: 1, medium: 2, high: 3 };

// Mode efficiency index (higher = better in congestion)
const MODE_EFFICIENCY = {
  walking: 5, metro: 4, bike: 3, scooter: 2.5, bus: 2, car: 1,
};

// Time savings per action (minutes)
const TIME_SAVINGS = { REROUTE: 14, SWITCH_MODE: 20, DELAY: 7, CONTINUE: 2 };

// Alternate routes by traffic + zone context
const ALT_ROUTES = [
  'via Outer Ring Road bypass',
  'via Hosur Road flyover',
  'via Sarjapur Road inner lane',
  'via NH-44 service road',
  'via Old Airport Road stretch',
  'via Tumkur Road expressway',
  'via Bellary Road alternate',
];

// Mode switch map based on transport + congestion level
const MODE_SWITCH_MAP = {
  car:     { high: 'bike',   extreme: 'metro' },
  scooter: { high: 'bike',   extreme: 'metro' },
  bus:     { high: 'metro',  extreme: 'metro' },
  bike:    { extreme: 'metro' },
  metro:   {},
  walking: {},
};

/**
 * Compute a weighted decision score for each possible action.
 * Returns { action, score, breakdown } for all 4 actions.
 */
function scoreActions({ user_type, transport, urgency, traffic }) {
  const ts = TRAFFIC_SCORE[traffic];
  const us = URGENCY_SCORE[urgency];
  const me = MODE_EFFICIENCY[transport] || 1;

  // --- CONTINUE score ---
  // Good when traffic is low, bad when high
  const continueScore = Math.max(0,
    10
    - ts * 2.5           // penalise traffic
    + (me * 0.8)         // efficient modes hurt less
    - (us * 0.3)         // urgency slightly penalises waiting
  );

  // --- REROUTE score ---
  // Good when traffic is medium-high but route alternatives exist
  const rerouteScore = Math.max(0,
    2
    + ts * 1.8           // benefits more at higher traffic
    + us * 1.2           // urgent users benefit more from reroute
    - (me > 3 ? 3 : 0)  // less benefit for already-efficient modes
    + (user_type === 'starting' ? 1.5 : 1) // starting users easier to reroute
  );

  // --- SWITCH_MODE score ---
  const targetMode = MODE_SWITCH_MAP[transport]?.[traffic];
  const targetEfficiency = targetMode ? MODE_EFFICIENCY[targetMode] : me;
  const efficiencyGain = targetEfficiency - me;
  const switchScore = Math.max(0,
    efficiencyGain * 2.2  // reward for efficiency gain
    + ts * 1.2            // higher traffic → more benefit
    + (us === 3 ? 2 : 0)  // urgency bonus
    - (me >= 4 ? 5 : 0)   // already on efficient mode — penalise
  );

  // --- DELAY score ---
  // Best when low urgency + high traffic; worst with high urgency
  const delayScore = Math.max(0,
    ts * 1.6              // high traffic rewards delay
    - us * 3.0            // urgency heavily penalises delay
    + (user_type === 'starting' ? 1 : -0.5)
  );

  return {
    CONTINUE:    parseFloat(continueScore.toFixed(2)),
    REROUTE:     parseFloat(rerouteScore.toFixed(2)),
    SWITCH_MODE: parseFloat(switchScore.toFixed(2)),
    DELAY:       parseFloat(delayScore.toFixed(2)),
  };
}

/**
 * Core decision function.
 */
function analyzeUser({ user_id, user_type, transport, urgency, traffic }) {
  const ts = TRAFFIC_SCORE[traffic];
  const us = URGENCY_SCORE[urgency];
  const scores = scoreActions({ user_type, transport, urgency, traffic });

  // Pick best action by score
  let bestAction = Object.entries(scores).reduce((a, b) => b[1] > a[1] ? b : a)[0];

  // Hard-override rules (business logic guardrails)
  if (user_type === 'stuck' && ts === 4 && us === 3) bestAction = ACTIONS.SWITCH_MODE;
  if (us === 1 && ts === 4) bestAction = ACTIONS.DELAY;
  if (ts <= 1) bestAction = ACTIONS.CONTINUE;
  if (transport === 'metro' || transport === 'walking') {
    if (bestAction === ACTIONS.SWITCH_MODE) bestAction = ACTIONS.CONTINUE;
  }

  // Build recommendation text
  const targetMode = MODE_SWITCH_MAP[transport]?.[traffic] || 'metro';
  const altRoute   = ALT_ROUTES[Math.floor(Math.random() * ALT_ROUTES.length)];
  const delayMin   = us === 1 ? (ts === 4 ? '45–60' : '20–30') : '15–20';

  let recommendation, reason;

  switch (bestAction) {
    case ACTIONS.SWITCH_MODE:
      recommendation = `Switch ${MODE_EMOJI[transport]} ${transport} → ${MODE_EMOJI[targetMode] || '🚇'} ${targetMode} now`;
      reason = `${traffic.charAt(0).toUpperCase() + traffic.slice(1)} congestion blocks current mode. ${targetMode} has ${((MODE_EFFICIENCY[targetMode] - MODE_EFFICIENCY[transport]) * 20).toFixed(0)}% higher route efficiency.`;
      break;
    case ACTIONS.REROUTE:
      recommendation = `Reroute ${altRoute}`;
      reason = `${user_type === 'stuck' ? 'Current route is congested' : 'Destination corridor is congested'}. Alternate path saves ~${TIME_SAVINGS.REROUTE} min.`;
      break;
    case ACTIONS.DELAY:
      recommendation = `Delay trip by ${delayMin} minutes — wait for congestion to ease`;
      reason = `Low urgency in ${traffic} traffic. Delaying reduces system load and your travel time.`;
      break;
    default:
      if (ts === 1) {
        recommendation = `All clear — proceed at full speed`;
        reason = `Roads are flowing freely. No intervention needed.`;
      } else if (ts === 2 && us === 3) {
        recommendation = `Depart now — traffic is manageable for urgent trip`;
        reason = `Medium traffic won't significantly impact your schedule.`;
      } else {
        recommendation = `Continue on current route with normal pace`;
        reason = `Traffic conditions are stable. Monitor for changes.`;
      }
  }

  // Confidence: how dominant the winning score is
  const scoreValues = Object.values(scores);
  const maxScore = Math.max(...scoreValues);
  const totalScore = scoreValues.reduce((a, b) => a + b, 0) || 1;
  const confidence = Math.min(99, Math.round((maxScore / totalScore) * 100 + 10));

  // Time saved estimate
  const timeSaved = TIME_SAVINGS[bestAction] || 2;

  return {
    user_id,
    user_type,
    transport,
    urgency,
    traffic,
    action:         bestAction,
    recommendation,
    reason,
    confidence,
    timeSaved,
    scores,
    altRoute,
    targetMode,
  };
}

/**
 * Generate a random simulation scenario.
 */
function randomScenario(index) {
  const types      = ['stuck', 'starting'];
  const transports = ['car', 'bike', 'bus', 'metro', 'scooter', 'walking'];
  const urgencies  = ['low', 'medium', 'high'];
  const traffics   = ['low', 'medium', 'high', 'extreme'];
  return {
    user_id:    `U${index + 1}`,
    user_type:  types[Math.floor(Math.random() * types.length)],
    transport:  transports[Math.floor(Math.random() * transports.length)],
    urgency:    urgencies[Math.floor(Math.random() * urgencies.length)],
    traffic:    traffics[Math.floor(Math.random() * traffics.length)],
  };
}

/**
 * Compute city-wide health score (0–100) from zone traffic levels.
 */
function cityHealthScore(zones) {
  const weights = { low: 100, medium: 65, high: 35, extreme: 5 };
  const avg = zones.reduce((sum, z) => sum + (weights[z.traffic] || 50), 0) / zones.length;
  return Math.round(avg);
}

window.SmartFlowEngine = {
  analyzeUser, randomScenario, scoreActions, cityHealthScore,
  ACTIONS, MODE_EMOJI, TIME_SAVINGS, MODE_EFFICIENCY,
};
