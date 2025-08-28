// server.js  (ESM)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// --- ESM path helpers ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware & static files ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Azure OpenAI config (env) ---
const endpoint   = process.env.AZURE_OPENAI_ENDPOINT;      // e.g., https://<res>.cognitiveservices.azure.com
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;    // your deployment name (e.g., "gpt-4o")
const apiVersion = process.env.AZURE_OPENAI_API_VERSION;   // e.g., "2025-01-01-preview"
const apiKey     = process.env.AZURE_OPENAI_API_KEY;

// --- In-memory data (replace with DB for multi-user) ---
let CURRENT_EVENTS = {calendar: []};     // array of mapped events
let CURRENT_PLAN_META = null;
let CURRENT_USER = {
  startDate: '2025-09-01',
  name: 'Hello World!',
  age: 40,
  gender: 'Male',
  heightIn: 65,
  weightLb: 150,
  targetWeightLb: 175,
  activityLevel: 'moderate',
  hoursPerWeek: 12,
  restDays: ['Tuesday'],
  trainDays: ['Sunday'],
  goals: ['endurance']
}

let MESSAGES = [];

let lastResponse = null;


const planSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'fitness_plan',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        meta: {
          type: 'object',
          additionalProperties: false,
          properties: {
            startDate: { type: 'string',format: 'date' }
          },
          required: [ 'startDate']
        },
        calendar: {
          type: 'array',
          minItems: 31,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              date: { type: 'string', format: 'date' },
              type: { type: ['string', 'null'], enum: ['rest', 'training']},
              workout: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  // allow null to keep key present even if model doesn't have a value
                  duration: { type: ['integer', 'null'], minimum: 5, maximum: 180 },
                  items: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 0
                  }
                },
                // 👇 include *every* property listed above
                required: [ 'duration', 'items']
              },

              meals: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string',enum: ['Breakfast', 'Lunch', 'Dinner']},
                    items: {
                      type: 'array',
                      items: { type: 'string' },
                      minItems: 0
                    }
                  },
                  // 👇 include all keys here too
                required: ['name', 'items']
                },
                minItems: 3,
                maxItems: 3
              }
            },
            // 👇 include all keys at this level
            required: ['date', 'type', 'workout', 'meals']
          }
        },
        overridesSummary: {
          type: ['string', 'null'],
        }
      },
      required: ['meta', 'calendar', 'overridesSummary']
    }
  }
};

// ===== Helpers: month overlap (UTC) =====
function monthRangeUtc(year, month /* 1-12 */) {
  const mIndex = month - 1;
  const start = new Date(Date.UTC(year, mIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, mIndex + 1, 0, 23, 59, 59, 999));
  return { start, end };
}
function toUtcRange(event) {
  if (event.allDay) {
    const start = new Date(`${event.start}T00:00:00Z`);
    const endStr = event.end || event.start;
    const end = new Date(`${endStr}T23:59:59.999Z`);
    return { start, end };
  }
  const start = new Date(event.start);
  const end = new Date(event.end || event.start);
  return { start, end };
}
function overlapsMonth(event, year, month) {
  const { start: mStart, end: mEnd } = monthRangeUtc(year, month);
  const { start: eStart, end: eEnd } = toUtcRange(event);
  return eEnd >= mStart && eStart <= mEnd;
}

function isNotBlank(str) {
  if (typeof str !== 'string' || str === null || typeof str === 'undefined') {
    return false; // Not a string, or is null/undefined
  }
  return str.trim().length > 0;
}

// ===== API: get monthly events =====


// GET /api/user
app.get('/api/user', async (req, res) => {
  res.json(CURRENT_USER);
});


// GET /api/user
app.post('/api/fitTrAIner', async (req, res) => {
  let newConstraint = req.body.input;
  if(isNotBlank(newConstraint)) {
    MESSAGES.push({"role": "user", "content": newConstraint});

    try {
      if (!endpoint || !deployment || !apiVersion || !apiKey) {
        return res.status(500).json({ error: 'Azure OpenAI is not configured. Check env vars.' });
      }
      
      const systemInstructions = [
        `You are a fitness planner. `,
      ].join('\n');

      const restDaysCSV   = CURRENT_USER.restDays.join(", ");
      const trainDaysCSV  = CURRENT_USER.trainDays.join(", ");
      const goalsCSV      = CURRENT_USER.goals.length ? CURRENT_USER.goals.join(", ") : "Build strength, Better shape / tone";

      let userInputs = [
        `Update the existing workout plan + nutrition plan as JSON. Start the first-day plan on the startDate.`,
        `Client: ${CURRENT_USER.name}, age ${CURRENT_USER.age}, gender ${CURRENT_USER.gender},`,
        `height ${CURRENT_USER.heightIn} inches, weight ${CURRENT_USER.weightLb}, target weight ${CURRENT_USER.targetWeightLb} lbs.`,
        `Activity level: ${CURRENT_USER.activityLevel}, ${CURRENT_USER.hoursPerWeek}  hours/week.`,
        `Rest days: ${restDaysCSV} Training days: ${trainDaysCSV}`,
        `Goals: ${goalsCSV}.`,
        `StartDate: ${CURRENT_USER.startDate}`,
        `Basic Guidelines:`,
        `- Calendar array must contain 28 elements.`,
        `- Calculate day of the week correctly for each day. First day may or may not be a Monday. It depends on the StartDate`,
        `- Use the client's rest/training days above.`,
        `- Keep workouts durations-only (no clock times).`,
        `- Meals should be realistic and goal-aligned. Include macronutrient information for each meal`,
        `- Plan must contain 28 days starting with today as the startDate`,
        `- Each week must contain a unique mealplan and workout schedule.`,
        `User Overrides:`,
        `- Only update the schedule for the future dates/days`
        ];

      // for (const message of MESSAGES) {
      //   if(message.role == "user") {
      //     userInputs.push("-"+message.content);
      //   }
      // }

      userInputs.push(MESSAGES[MESSAGES.length-1].content);

      const userInput = userInputs.join('\n');


      const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
      const body = {
        messages: [
          { role: 'system', content: systemInstructions },
          { role: 'user', content: userInput },
          { role: 'user', content: `Schedule currently stands as below:\n ${JSON.stringify(CURRENT_EVENTS)}` }
        ],
        temperature: 0.7,
        response_format: planSchema
      };
      console.log("BODY: ", body);

      // if(lastResponse === null) {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey
          },
          body: JSON.stringify(body)
        });

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Azure OpenAI error ${resp.status}: ${errText}`);
        }
        lastResponse = await resp.json();
      // }

      const data = lastResponse;

      // choices[0].message.content can be a string or array of parts in previews
      function extractText(msg) {
        if (!msg) return '';
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
          const part = msg.content.find(p => p?.type === 'text');
          return part?.text ?? '';
        }
        return '';
      }

      // console.log("MESSAGE: ", data?.choices?.[0]?.message);
      console.log("MESSAGE: ", JSON.stringify(data));
      console.log('finish_reason:', data?.choices?.[0]?.finish_reason);
      console.log('usage:', data?.usage); // prompt_tokens, completion_tokens, total_tokens
      const text = extractText(data?.choices?.[0]?.message);
      if (!text) throw new Error('Empty response from Azure OpenAI.');
      // const plan = JSON.parse(text);

      // Map to calendar events
      // const mapped = planToEvents(plan, startDate);
      // CURRENT_EVENTS = mapped;
      // CURRENT_PLAN_META = { startDate, days, goal, level, dietary, unavailable, notes, model: deployment };

      // res.json({ planMeta: CURRENT_PLAN_META, count: CURRENT_EVENTS.length, events: CURRENT_EVENTS });

      CURRENT_EVENTS = JSON.parse(text);
      MESSAGES.push({"role": "assistant", "content": CURRENT_EVENTS.overridesSummary || "Check the Updated schedule"});
      res.json({messages: MESSAGES});
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update plan', detail: String(err?.message || err) });
    }
  }

});

// GET /api/events?year=YYYY&month=MM
app.get('/api/events', async (req, res) => {
  const year = parseInt(String(req.query.year), 10);
  const month = parseInt(String(req.query.month), 10);
  if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12 || year < 1900 || year > 2100) {
    return res.status(400).json({ error: 'Provide valid year (e.g., 2025) and month (1-12).' });
  }
  res.json(CURRENT_EVENTS);
});

// ===== API: generate/update plan with Azure OpenAI =====
// POST /api/plan/generate
// Body: { startDate:'YYYY-MM-DD', days:30, goal, level, dietary:{preferences[], caloriesTarget?}, unavailable:{weekdays[], dates[], ranges?[]}, notes? }
app.post('/api/plan/generate', async (req, res) => {
  try {
    if (!endpoint || !deployment || !apiVersion || !apiKey) {
      return res.status(500).json({ error: 'Azure OpenAI is not configured. Check env vars.' });
    }
    
    const systemInstructions = [
      `You are a fitness coach and nutritionist. `,
    ].join('\n');

    let payload = req.body;
    CURRENT_USER = payload;
    MESSAGES = [];
    if(CURRENT_USER.startDate == null) {
      CURRENT_USER.startDate = '2025-09-01';
    }

    const restDaysCSV   = payload.restDays.join(", ");
    const trainDaysCSV  = payload.trainDays.join(", ");
    const goalsCSV      = payload.goals.length ? payload.goals.join(", ") : "Build strength, Better shape / tone";

    const userInput = [
      `Create a 28-day workout + nutrition plan as JSON. Start the first-day plan on the startDate.`,
      `Client: ${payload.name}, age ${payload.age}, gender ${payload.gender},`,
      `height ${payload.heightIn} inches, weight ${payload.weightLb}, target weight ${payload.targetWeightLb} lbs.`,
      `Activity level: ${payload.activityLevel}, ${payload.hoursPerWeek}  hours/week.`,
      `Rest days: ${restDaysCSV} Training days: ${trainDaysCSV}`,
      `Goals: ${goalsCSV}.`,
      `StartDate: ${CURRENT_USER.startDate}`,
      `Basic Guidelines:`,
      `- Calendar array must contain 28 elements.`,
      `- Calculate day of the week correctly for each day. First day may or may not be a Monday. It depends on the StartDate`,
      `- Use the client's rest/training days above.`,
      `- Add specific workout items/exercises for each workout day. This should be detailed and have a mix of different workouts with different numbers of reps.`,
      `- Meals should be detailed and goal-aligned. Include portion sizes and macronutrient information for each meal item that factor the current weight and target weight`,
      `- Each week must contain a unique meal plan and workout schedule`,
      `- Plan MUST contain 28 days starting with today as the startDate.`
    ].join('\n');

    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const body = {
      messages: [
        { role: 'system', content: systemInstructions },
        { role: 'user', content: userInput }
      ],
      temperature: 0.7,
      response_format: planSchema
    };
    console.log("BODY: ", body);

    // if(lastResponse === null) {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey
        },
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Azure OpenAI error ${resp.status}: ${errText}`);
      }
      lastResponse = await resp.json();
    // }

    const data = lastResponse;

    // choices[0].message.content can be a string or array of parts in previews
    function extractText(msg) {
      if (!msg) return '';
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        const part = msg.content.find(p => p?.type === 'text');
        return part?.text ?? '';
      }
      return '';
    }

    // console.log("MESSAGE: ", data?.choices?.[0]?.message);
    console.log("MESSAGE: ", JSON.stringify(data));
    console.log('finish_reason:', data?.choices?.[0]?.finish_reason);
    console.log('usage:', data?.usage); // prompt_tokens, completion_tokens, total_tokens
    const text = extractText(data?.choices?.[0]?.message);
    if (!text) throw new Error('Empty response from Azure OpenAI.');
    // const plan = JSON.parse(text);

    // Map to calendar events
    // const mapped = planToEvents(plan, startDate);
    // CURRENT_EVENTS = mapped;
    // CURRENT_PLAN_META = { startDate, days, goal, level, dietary, unavailable, notes, model: deployment };

    // res.json({ planMeta: CURRENT_PLAN_META, count: CURRENT_EVENTS.length, events: CURRENT_EVENTS });

    CURRENT_EVENTS = JSON.parse(text);  
    res.json(CURRENT_EVENTS);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate plan', detail: String(err?.message || err) });
  }
});

// ===== Mapping helpers (plan -> events) =====
// event shape: { id, title, allDay, start, end, color, type: 'workout'|'meal', meta:{} }
function planToEvents(plan, startDate) {
  const base = new Date(`${startDate}T00:00:00`);
  const events = [];
  let counter = 1;

  for (const dayObj of plan.days) {
    const idx = Math.max(1, dayObj.day) - 1;
    const date = addDays(base, idx);
    const iso = fmtDate(date);
    // console.log(dayObj);
    // Workout event
    const w = dayObj.workout;
    if (w) {
      const [hh, mm] = (w.start_time || '07:00').split(':').map(Number);
      const start = new Date(date);
      start.setHours(hh, mm ?? 0, 0, 0);
      const end = addMinutes(start, clampInt(w.duration_minutes ?? 60, 5, 180));
      const isRest = !!dayObj.rest_day;

      events.push({
        id: `w-${counter++}`,
        title: isRest ? 'Rest / Recovery' : w.title,
        allDay: isRest,
        start: isRest ? iso : start.toISOString(),
        end:   isRest ? iso : end.toISOString(),
        color: '#22c55e',
        type: 'workout',
        meta: {
          intensity: w.intensity || 'moderate',
          description: w.description || '',
          muscle_groups: w.muscle_groups || [],
          equipment: w.equipment || []
        }
      });
    }

    // Meal event (all-day)
    const m = dayObj.meals;
    if (m) {
      events.push({
        id: `m-${counter++}`,
        title: 'Meal Plan',
        allDay: true,
        start: iso,
        end: iso,
        color: '#f59e0b',
        type: 'meal',
        meta: { ...m }
      });
    }
  }
  return events;
}

// ===== tiny utils =====
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function addMinutes(d, mins) { const r = new Date(d); r.setMinutes(r.getMinutes() + mins); return r; }
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function clampInt(v, min, max) { return Math.max(min, Math.min(max, parseInt(v, 10))); }

// ===== Start server =====
app.listen(PORT, () => {
  console.log(`Calendar server running at http://localhost:${PORT}`);
});
