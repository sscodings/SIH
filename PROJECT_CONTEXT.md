# AI-Enabled Real-Time Digital Twin System for Aero Piston Engines in MALE UAVs
### Master Project Reference Document — Smart India Hackathon

**Purpose of this document:** This is the single source of truth for the project — problem, approach, architecture, current build status, team responsibilities, and every technical decision made along the way. Anyone (a new teammate, a mentor, or an AI coding assistant like Antigravity) should be able to read this and understand the full project without needing prior context.

---

## 1. Problem Statement

**Title:** AI-Enabled Real-Time Digital Twin System for Health Monitoring, Fault Prediction and Mission Reliability Enhancement of Aero Piston Engines used in MALE UAVs.

**Core issue:** Medium Altitude Long Endurance (MALE) UAVs rely on aero piston engines for long-duration ISR (Intelligence, Surveillance, Reconnaissance) missions. Current onboard engine monitoring is threshold-based and reactive — it flags problems only after they've already occurred, cannot estimate Remaining Useful Life (RUL, i.e. how much operational life is left before failure), and cannot simulate how the engine would behave under different missions or environments in advance.

**Goal:** Build a Digital Twin — a continuously synchronized virtual replica of the physical engine — that uses real-time (simulated) sensor data, physics-based modeling, and AI/ML to detect early warning signs, classify known faults, catch unknown/novel faults, estimate Remaining Useful Life, and visualize all of this for an operator.

---

## 2. Real-World Grounding

This project is not purely theoretical — it's built around a real, currently operational Indian defence platform.

- **Reference engine:** Rotax 914 — a turbocharged 4-cylinder aero piston engine (approx. 115 hp), one of the most widely used and well-documented UAV piston engines in the world.
- **Reference platform:** IAI Heron, a Medium Altitude Long Endurance UAV powered by the Rotax 914, operated by the **Indian Air Force, Indian Navy, and Indian Army**.
- **Real incident used as motivation:** An Indian Navy Heron UAV crashed near Porbandar, Gujarat on 22 March 2018, with the cause recorded as engine failure. This is a genuine, citable case showing exactly the kind of failure this project aims to predict in advance.
- **Correction made during research:** Rustom-2 (TAPAS-BH-201), often mislabeled in older sources as using a turboprop engine (NPO Saturn 36MT), actually flew on piston engines in its real prototypes — first the Rotax 914, later upgraded to the Austro AE300 (a turbo-diesel piston engine). The Austro AE300 also had a documented real-world altitude-performance shortfall on Rustom-2, which is a second usable case study for "why predictive monitoring matters," though the Rotax 914/Heron pairing remains the primary reference for this project due to better public documentation.

**Sources to cite / verify further:**
- Rotax 914 official specifications and operator manual (BRP-Rotax)
- Public reporting on IAI Heron operations by Indian Air Force/Navy/Army
- Public reporting on the March 2018 Indian Navy Heron crash near Porbandar
- Public reporting on Rustom-2 / TAPAS-BH-201 engine history (Rotax 914 → Austro AE300) and altitude performance issues
*(Team should keep original article links saved separately alongside this document for citation in the final presentation.)*

---

## 3. System Architecture — How the Pieces Connect

```
 ┌────────────────────┐     ┌────────────────────┐
 │ Environment         │     │ Mission Profile     │
 │ Generator            │     │ Generator            │
 │ (temp, pressure,     │     │ (throttle, RPM,      │
 │ humidity, altitude)  │     │ altitude vs time)     │
 └──────────┬──────────┘     └──────────┬──────────┘
            │                            │
            └────────────┬───────────────┘
                          ▼
              ┌───────────────────────┐
              │  Physics Engine Model  │  ← core thermodynamic equations
              │  (engine_physics.py)   │
              └───────────┬───────────┘
                          ▼
              ┌───────────────────────┐
              │ Fault Injection Module │  ← deliberately injects known
              │                         │     faults with labels
              └───────────┬───────────┘
                          ▼
              ┌───────────────────────┐
              │  Sensor Noise Layer    │  ← makes data look like real
              │                         │     imperfect telemetry
              └───────────┬───────────┘
                          ▼
              ┌────────────────────────────────────┐
              │        Generated Telemetry CSV       │  ← THE DATA CONTRACT
              └───────────┬────────────┬────────────┘
                          ▼            ▼
              ┌───────────────┐  ┌──────────────────┐
              │   AI/ML Layer  │  │ 3D Visualization  │
              │ (3 sub-layers) │  │ (React Three Fiber)│
              └───────┬───────┘  └─────────┬────────┘
                      ▼                     │
              ┌───────────────┐             │
              │   Dashboard    │◄────────────┘
              │ (status, alerts,│
              │  RUL, replay)  │
              └───────────────┘
```

**Key design decision:** Environment and mission are generated *separately* and fed together into the physics model, rather than combined into one input — this allows testing realistic combined worst cases (e.g. "hot day + long endurance mission") rather than only isolated conditions.

---

## 4. The Data Contract

This is the agreed structure of the data every team builds against. Established early specifically so simulation, AI, and visualization/dashboard teams could work in parallel using placeholder data before the real simulation was finished.

```
timestamp
mission_time_elapsed
altitude
ambient_temperature
ambient_humidity
throttle_position
rpm
cht_cyl1, cht_cyl2, cht_cyl3, cht_cyl4      (Cylinder Head Temperature, one per cylinder)
egt_cyl1, egt_cyl2, egt_cyl3, egt_cyl4      (Exhaust Gas Temperature, one per cylinder)
oil_pressure
oil_temperature
fuel_flow
vibration_level
vibration_dominant_frequency
battery_voltage
alternator_output
injection_timing
fault_label          (healthy / which fault / none — ground truth, known because it was injected)
fault_severity        (0 to 1, how far into the fault the engine is — for RUL training)
```

**Note (current status):** the team's built simulation does not yet output battery/alternator health or injection timing columns — see Section 8 for full status.

---

## 5. Parameters and What They Reveal

| Parameter | What it measures | What abnormal readings suggest |
|---|---|---|
| **RPM** | Engine rotation speed | Drops/fluctuation → misfire or fuel delivery issue |
| **Cylinder Head Temperature (CHT)** | Heat at each cylinder's head | Rising on one cylinder → localized issue (injector/plug); rising on all → cooling system failure or hot ambient + high power for too long |
| **Exhaust Gas Temperature (EGT)** | Heat of exhaust gases per cylinder | Spike → lean mixture/injector clog; sudden drop → misfire on that cylinder |
| **Oil Pressure** | Force of oil circulation | Falling → failing oil pump, leak, low oil, or clogged filter — urgent, can destroy engine fast |
| **Oil Temperature** | Heat absorbed by circulating oil | Rising without pressure issue → oil cooler problem or prolonged heat exposure |
| **Fuel Flow** | Fuel delivered to engine | Too high → injector stuck open (rich); too low → blocked line/failing pump (lean) |
| **Vibration Signature** | Physical shaking, and its frequency content | Steady rise → general wear (bearings, mounts); new frequency → specific mechanical fault (misfire, imbalance) |
| **Battery/Alternator Health** | Electrical voltage/current | Voltage drop → alternator not charging properly; spike → faulty voltage regulator |
| **Injection Timing** | Precise timing of fuel injection per cylinder cycle | Drift over time → wearing sensor/actuator in fuel injection system |

**Named fault types from the problem statement, and which parameters reveal each:**

| Fault | Physically is | Revealed by |
|---|---|---|
| Misfire | Cylinder fails to ignite properly | EGT drop (that cylinder), RPM fluctuation, vibration spike |
| Injector abnormalities | Injector delivers wrong fuel amount/timing | Fuel flow mismatch, EGT change (specific cylinder), timing drift |
| Cooling degradation | Cooling system losing effectiveness | Steadily rising CHT (and oil temp) across cylinders |
| Lubrication issues | Oil system failing to protect moving parts | Falling oil pressure, rising oil temperature |
| Sensor drift/failure | A sensor's readings become inaccurate | Inconsistency with other parameters/expected physics |
| Combustion instability | Unstable fuel-air mixture/ignition | RPM oscillation, unusual-frequency vibration, erratic EGT |
| Overheating trends | General excess heat build-up | Rising CHT/oil temp over time |
| Abnormal vibration patterns | Bearing wear, imbalance, loose mount | Vibration signature changes |

---

## 6. AI/ML Approach — Three Layers

1. **Layer 1 — Individual parameter checks (rule-based, no training needed).** Simple/physics-informed threshold checks per parameter. Serves as the "old, conventional way" baseline for comparison.
2. **Layer 2 — Known fault classification (should be a trained supervised model).** Trained on labeled examples of the 8 named fault types (from the injected fault data) so the model *learns* to recognize and name each fault from patterns in the data, rather than being told the rules by a human.
3. **Layer 3 — Unknown/novel anomaly detection (unsupervised model, e.g. autoencoder).** Trained *only* on healthy data, so it learns what "normal" looks like and flags anything that deviates — including fault types nobody explicitly coded a rule for. This is what proves the system goes beyond the problem statement's named fault list.

**Why all three matter together:** when a fault occurs, Layer 1 might miss it (no single parameter crossed a hard line yet), Layer 2 may confidently name it (if it matches a known learned pattern), and Layer 3 flags "this doesn't look normal" regardless of whether it's a known or unknown fault type. Showing all three statuses on the dashboard side by side is a strong demo of superiority over "conventional threshold-based monitoring."

---

## 7. 3D Visualization Pipeline (Digital Twin "Body")

**Concept:** Python/simulation is the "brain" (all physics and fault logic); the 3D visualization is the "body" — it only displays what the brain computes, with no physics logic of its own.

**Model sourcing journey (for reference/reuse by future teammates):**
1. Initial idea of scraping a 3D model from Rotax's official web configurator was **rejected** — that model is proprietary IP belonging to BRP-Rotax, likely protected against extraction, and using it would raise real IP/legal concerns even for a hackathon.
2. Found a community-uploaded Rotax 914 CAD assembly on **GrabCAD** — a legitimate source since users upload their own work with (variable) reuse licenses. License terms should be double-checked/confirmed for the specific listing used.
3. The GrabCAD download contained a mix of file formats: `.sldprt`/`.sldasm` (proprietary SolidWorks formats, not easily convertible) and `.x_t` (Parasolid format) and, critically, a `.stp` (STEP) file containing the **entire correctly assembled engine** — STEP being an open, standardized format that preserves full multi-part assemblies.
4. The `.stp` file was opened directly in **Blender** (v3.5+, which has native STEP import).
5. In Blender, the imported assembly was confirmed to consist of many separate sub-objects (not one merged mesh) — necessary for independently coloring/animating specific parts (cylinders, oil pan) based on sensor data.
6. Key sub-objects were manually identified (by clicking each in the Outliner and observing which geometry highlights) and **renamed** to clear, consistent names (`cylinder_1`–`cylinder_4`, `oil_pan`, `crankcase`, etc.) matching the data contract, before export.
7. Exported from Blender as **glTF Binary (.glb)** — the standard format for loading 3D models into web-based 3D engines like Three.js.

**Current tech stack (chosen to match the developer's existing MERN/React background):**
- **React Three Fiber** (`@react-three/fiber`) — React wrapper around Three.js (the underlying WebGL 3D library), allows building the 3D scene declaratively with JSX instead of imperative Three.js code.
- **@react-three/drei** — helper library providing `useGLTF`, a ready-made hook for loading `.glb` files.
- **Vite** — project scaffolding/build tool (`npm create vite@latest`), used to set up the React project.
- Model file (`rotax914.glb`) placed in the project's `public/` folder so it's servable at a direct URL path.

**Data connection plan:** the 3D scene reads live sensor values (currently from a dummy/simulated data hook, later from the real simulation output — likely via an Express + MongoDB endpoint given the team's MERN background, or a shared CSV/JSON file) and maps specific values to visual changes — e.g., a cylinder's color interpolates from grey (normal) → orange (caution) → red (critical) based on its live CHT reading; the propeller's rotation speed is tied to RPM.

**Known technical note:** glTF export from Blender may sanitize part names (spaces become underscores, etc.) — always verify actual names loaded in-browser via `console.log(Object.keys(nodes))` before writing targeting code, rather than assuming the Blender names carry over exactly.

---

## 8. Current Build Status (as of last review)

### Simulation — largely complete, high quality
Files reviewed and test-run successfully:
- `generate_climate_dataset.py` — generates realistic environment data using real atmospheric physics (International Standard Atmosphere model), across multiple named weather profiles (hot desert, cold winter, humid maritime, monsoon).
- `engine_physics.py` — implements real thermodynamic equations: manifold pressure with turbo boost and altitude saturation, Hagen-Poiseuille oil pressure/flow, Vogel's equation for oil viscosity vs. temperature, combustion-driven EGT via fuel-air equivalence ratio. Assumptions not backed by confirmed specs are explicitly flagged in comments.
- `simulate_engine_telemetry.py` — combines the above into full mission telemetry generation, including fault injection for 3 fault types (misfire, lubrication degradation, cooling degradation) with clean ground-truth labels.

**Gaps to close:**
- Sensor noise is present but inconsistent across parameters — needs a deliberate, uniform noise/dropout layer applied to all outputs.
- Battery/alternator health and injection timing parameters (named in the problem statement and data contract) are not yet generated.
- Only 3 of the 8 named fault types are currently injectable — injector abnormalities, sensor drift/failure, combustion instability, and abnormal vibration patterns are not yet implemented.
- Oil pressure was observed hitting its relief-valve cap in over 25% of samples during testing — worth re-tuning so the relief cap is a rare edge case, not a frequent ceiling, to preserve useful signal variance for fault detection.

### AI/ML — one real trained model; the rest is rule-based
File reviewed and test-run successfully: `anomaly_detection.py`

- **Layer 1 (baseline checks):** implemented as a `PhysicsRuleEngine` — hand-written, physics-informed threshold rules (more sophisticated than plain fixed thresholds, e.g. compares measured oil pressure against physics-model-predicted expected pressure). Not a trained model — none needed for this layer.
- **Layer 2 (known fault classification via trained model):** **not actually implemented.** What exists instead is hand-coded if/else logic (the same `PhysicsRuleEngine`, plus a fallback heuristic that guesses fault type based on which sensor showed the largest deviation) — this produces correct-looking fault labels but is not a model that learned fault patterns from labeled training data. This is the most significant outstanding gap in the AI/ML layer.
- **Layer 3 (unknown fault detection):** **implemented and working.** A real trained autoencoder (an `MLPRegressor` configured in a bottleneck architecture — 64→32→16→32→64 — trained to reconstruct its own input), trained exclusively on healthy-labeled data, flags deviations via reconstruction error. Tested and produced 95–100% recall across the 3 implemented fault types.
- **Explainability:** a simplified homemade substitute exists (reports which specific sensor had the largest reconstruction error) but is not the standard SHAP/LIME tooling originally planned.
- **Remaining Useful Life (RUL):** not implemented as a dedicated sequence model (e.g. LSTM). A `Health_Index` value that decays with wear exists as a partial proxy.

**Important caveat found during testing:** the false alarm rate on healthy validation data measured 3.30%, above the team's own stated <1% target — worth investigating before presenting results. Additionally, the lubrication-fault detection is close to guaranteed by construction (the "expected" oil pressure is calculated with the same formula used to generate the actual value, just scaled down during the fault), so that specific 100% recall figure is likely optimistic versus real-world noisy sensor performance — worth an honest caveat in the presentation rather than presenting unqualified.

**Priority for the AI/ML team going forward:** build an actual trained classifier (e.g. Random Forest or a small neural network) using the labeled fault data as training targets for Layer 2, and — critically — get the simulation team to inject at least one fault type the physics rules were never written for, so Layer 3 can be demonstrated catching a genuinely novel/unmodeled fault. This is the specific evidence needed to prove the "detects new/unknown faults" claim central to the project's value proposition.

### 3D Visualization — foundation in progress
- Real, correctly-assembled Rotax 914 CAD model successfully sourced, imported into Blender, cleaned, part-renamed, and exported to `.glb`.
- React Three Fiber + Vite project scaffolded.
- Model loading code (`useGLTF`) and sensor-to-color mapping logic drafted, pending final verification of part names surviving the glTF export and connection to real (vs. dummy) simulation data.

### Dashboard — not yet started in detail
Planned approach (Streamlit/Plotly Dash or Grafana + InfluxDB) documented; no build status to report yet. Recommended to start immediately against a dummy CSV matching the data contract, per the parallel-work strategy used by the other teams.

### Presentation — not yet started in detail
Should incorporate: the real-world Heron/Rotax 914 Indian defence context, the Porbandar crash case study, the architecture diagram (Section 3), and an honest "what's built vs. in progress" status slide — transparency about current gaps (e.g. Layer 2) is more credible to judges than overstating completeness.

---

## 9. Team Structure and Responsibilities

*(Roles described by function, not by name — see team's internal notes for current assignments.)*

| Function | Responsibility | Software/Tools |
|---|---|---|
| Engine Simulation | Environment + mission generators, physics engine model, fault injection | Python (NumPy, SciPy, pandas), CoolProp, Rotax 914 spec sheet, Heywood's *Internal Combustion Engine Fundamentals*, NASA Technical Reports Server |
| 3D Visualization | Digital twin "body" — visual model reacting to live sensor data | Blender, React Three Fiber, @react-three/drei, Vite, GrabCAD-sourced CAD model |
| AI/ML Modeling | Three-layer fault detection (baseline, known-fault classifier, novel-anomaly detector), RUL estimation, explainability | Python (scikit-learn, TensorFlow/PyTorch), SHAP/LIME, NASA C-MAPSS dataset and PHM Society resources as RUL methodology references |
| Engine Research & 2D Design | Real engine specs/ranges for grounding the simulation; labeled 2D diagrams reused across dashboard/presentation | Rotax 914 manuals, published UAV incident reports, Figma/Canva/Adobe Illustrator |
| Dashboard | Operator-facing live parameter view, fault alerts (all 3 AI layers), maintenance advisories, mission replay | Streamlit / Plotly Dash, or Grafana + InfluxDB |
| Presentation | Overall narrative, architecture diagrams, demo flow | PowerPoint / Canva |

---

## 10. Software and Tools Reference (Full List)

- **Python** — NumPy, SciPy, pandas, scikit-learn, CoolProp, TensorFlow/PyTorch, SHAP/LIME
- **Blender** (v3.5+) — native STEP import, glTF export
- **CAD Assistant** (Open Cascade, free) — viewing Parasolid (`.x_t`) files
- **React Three Fiber** (`@react-three/fiber`) + **@react-three/drei** — 3D rendering in React
- **Vite** — React project scaffolding and dev server
- **Three.js** — underlying WebGL 3D library (used indirectly via React Three Fiber)
- **Streamlit** / **Plotly Dash** or **Grafana + InfluxDB** — dashboard
- **Figma / Canva / Adobe Illustrator** — 2D diagrams
- **GitHub** — shared repository and version control across all teams

---

## 11. References and Research Sources

- Heywood, John B. — *Internal Combustion Engine Fundamentals* (standard textbook reference for combustion thermodynamics, heat transfer correlations)
- NASA Technical Reports Server (NTRS) — mean-value/quasi-dimensional engine modeling reports
- NASA C-MAPSS dataset — turbofan degradation dataset used as a methodology template for structuring Remaining Useful Life training data (not a piston-engine dataset, but standard reference for RUL model structure)
- PHM Society (Prognostics and Health Management Society) — datasets and conference papers on fault diagnosis/prognostics methodology
- Rotax 914 official specifications and operator/maintenance manual (BRP-Rotax)
- GrabCAD — community-uploaded Rotax 914 CAD assembly (verify specific listing's license terms before final use)
- Public reporting on IAI Heron operations by Indian armed forces, and the March 2018 Porbandar crash (engine failure)
- Public reporting on Rustom-2 / TAPAS-BH-201 engine history and the Austro AE300 altitude-performance issue

*(Team should retain direct article links/URLs separately for exact citation in the final report/presentation, as this document summarizes findings without embedding every original link.)*

---

## 12. Open Items / Next Steps Summary

1. Simulation: add remaining 5 fault types, battery/alternator + injection timing outputs, uniform sensor noise layer, re-tune oil pressure relief cap frequency.
2. AI/ML: build the actual trained Layer 2 classifier; get simulation to inject one truly novel fault type for Layer 3 to prove itself against; investigate the 3.30% false alarm rate; add real SHAP/LIME explainability; build a dedicated RUL sequence model.
3. 3D Visualization: confirm part names survive glTF export; connect to real (non-dummy) simulation data feed.
4. Dashboard: begin build against dummy CSV matching the data contract.
5. Presentation: begin skeleton now; include an honest current-status slide.
