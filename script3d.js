import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

document.addEventListener('DOMContentLoaded', () => {

    // --- CONFIGURATION ---
    const urlParams = new URLSearchParams(window.location.search);
    const mapFileNameFromURL = urlParams.get('map');
    const DEFAULT_MAP = 'all_that_glitters_v2.2.3';
    const currentMapFileName = mapFileNameFromURL || DEFAULT_MAP;

    // const MAP_API_URL = 'https://api.bar-rts.com/maps/all_that_glitters_v2.2.3';
    let MAP_API_URL = `https://api.bar-rts.com/maps/${currentMapFileName}`;
    const UNIT_DEFS_URL = 'unit_definitions.json';
    const REPLAY_DATA_URL = 'unit_positions.csv';
    const FPS = 30;
    let WATER_LEVEL = 0; // <<< NEW: Define the map's water level
    const TEAM_COLORS = {
        '1': 0xff4d4d, '2': 0x4d94ff, '3': 0x33cc33, '4': 0xffff4d,
        '5': 0xff9933, '6': 0xbf80ff, '7': 0xff66cc, '8': 0x66d9ff,
        'default': 0xcccccc
    };
    // --- MAP PROPS - dynamic from API request (default to glitters for now)
    let MIN_MAP_HEIGHT = 100;
    let MAX_MAP_HEIGHT = 800;

    // --- DOM ELEMENTS ---
    const canvasContainer = document.getElementById('canvas-container');
    const controlsDiv = document.getElementById('controls');
    const timeSlider = document.getElementById('time-slider');
    const timeDisplay = document.getElementById('time-display');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const resetBtn = document.getElementById('reset-btn');
    const teamFilter = document.getElementById('team-filter');
    const unitFilter = document.getElementById('unit-filter');
    const spriteCountDisplay = document.getElementById('sprite-count-display');
    const mapSelector = document.getElementById('map-selector');

    // --- APP STATE & THREE.JS SETUP ---
    let scene, camera, renderer, orbitControls;
    let imageWidth, imageHeight;
    let mapMetadata = {}, unitDefinitions = {}, unitTimelines = {}, unitSprites = {};
    let minFrame = Infinity, maxFrame = -Infinity, currentFrame = 0, isPlaying = false;
    let mapWidthWorld, mapHeightWorld;
    let heightDataContext;
    let terrainMesh;
    let waterPlane; // <<< NEW: To hold our water mesh
    let displacementCanvas, displacementContext, baseHeightImageData, displacementTexture;

    // --- MUTATOR STATE ---
    let mutatorChain = []; // This will hold our chain of mutator objects
    let baseHeightData; // <<< NEW: Will store a Float32Array of real map heights

    async function loadAndPopulateMaps() {
        try {
            const response = await fetch('https://api.bar-rts.com/maps?limit=1000');
            if (!response.ok) throw new Error('Failed to fetch map list');
            const mapData = await response.json();

            mapSelector.innerHTML = ''; // Clear "Loading..." message

            // Sort maps alphabetically by their descriptive name
            const sortedMaps = mapData.data.sort((a, b) => {
                const nameA = a.scriptName || a.fileName;
                const nameB = b.scriptName || b.fileName;
                return nameA.localeCompare(nameB);
            });

            sortedMaps.forEach(map => {
                const option = document.createElement('option');
                option.value = map.fileName;
                // Use the more descriptive 'scriptName' as the text, falling back to 'fileName'
                option.textContent = map.scriptName || map.fileName; 
                mapSelector.appendChild(option);
            });

            // Set the dropdown to show the currently loaded map
            mapSelector.value = currentMapFileName;

            // Add an event listener to reload the page with the new map on change
            mapSelector.addEventListener('change', (event) => {
                const newMap = event.target.value;
                window.location.search = `?map=${newMap}`;
            });

        } catch (error) {
            console.error("Could not load map list:", error);
            mapSelector.innerHTML = '<option value="">Error loading maps</option>';
        }
    }

    // --- MAIN INITIALIZATION ---
    async function initialize() {
        try {
            console.log("Step 1: Loading metadata...");
            await loadMapMetadata();
            await loadUnitDefinitions();

            console.log("Step 2: Initializing 3D Scene...");
            initThreeJsScene();

            console.log("Step 3: Creating 3D terrain...");
            await createTerrain();
            createWaterPlane(); // <<< NEW: Call this after creating the terrain

            console.log("Step 4: Loading icons and replay data...");
            // The loadUnitIcons function is a placeholder for logical flow;
            // actual loading happens in createUnitSprites.
            await loadUnitIcons();
            await loadReplayData();

            console.log("Step 5: Creating 3D unit sprites...");
            createUnitSprites();

            console.log("Step 6: Initializing UI...");
            initializeUI();
            initializeMutatorControls();
            initializeWaterControls();

            // addTestBoxes();

            console.log("Step 7: Drawing the initial frame...");
            // FIX #3: Draw the first frame to show initial unit positions.
            updateFrame(currentFrame);

            console.log("Setup complete. Starting animation loop.");
            startAnimationLoop();

        } catch (error) {
            console.error("A fatal error occurred during initialization:", error);
            document.body.innerHTML = `<h1>Fatal Error</h1><p>${error.message}</p>`;
        }
    }

    // --- DATA LOADING & SETUP ---
    async function loadMapMetadata() {
        const response = await fetch(MAP_API_URL);
        if (!response.ok) throw new Error(`Could not fetch map metadata`);
        mapMetadata = await response.json();
        MIN_MAP_HEIGHT = mapMetadata.minDepth;
        MAX_MAP_HEIGHT = mapMetadata.maxDepth;
        mapWidthWorld = mapMetadata.width * 512;
        mapHeightWorld = mapMetadata.height * 512;
    }

    async function loadUnitDefinitions() {
        const response = await fetch(UNIT_DEFS_URL);
        if (!response.ok) throw new Error(`Could not fetch ${UNIT_DEFS_URL}`);
        unitDefinitions = await response.json();
    }

    async function loadReplayData() {
        const response = await fetch(REPLAY_DATA_URL);
        if (!response.ok) throw new Error(`Could not fetch ${REPLAY_DATA_URL}`);
        const csvData = await response.text();
        const rows = csvData.trim().split('\n');
        const headers = rows.shift().trim().split(',');
        const col = headers.reduce((acc, val, i) => ({ ...acc, [val]: i }), {});

        // Make sure the 'y' column exists
        if (!('y' in col)) {
            throw new Error("CSV file is missing the required 'y' column for height data.");
        }

        rows.forEach(row => {
            const values = row.trim().split(',');
            if (values.length < headers.length) return;
            const unit_id = values[col.unit_id];
            const uDefName = values[col.uDefName];
            if (!unitDefinitions[uDefName]) return;

            if (!unitTimelines[unit_id]) {
                unitTimelines[unit_id] = { data: [], uDefName, team_id: values[col.team_id] };
            }
            const frame = parseInt(values[col.frame], 10);
            unitTimelines[unit_id].data.push({
                frame,
                x: parseFloat(values[col.x]),
                y: parseFloat(values[col.y]) - 100,
                z: parseFloat(values[col.z])
            });
            minFrame = Math.min(minFrame, frame);
            maxFrame = Math.max(maxFrame, frame);
        });

        for (const unitId in unitTimelines) {
            unitTimelines[unitId].data.sort((a, b) => a.frame - b.frame);
        }
    }

    async function loadUnitIcons() {
        return Promise.resolve();
    }

    // --- 3D SCENE SETUP ---
    function initThreeJsScene() {
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x333744);

        imageWidth = 1024;
        imageHeight = 1024;

        camera = new THREE.PerspectiveCamera(75, imageWidth / imageHeight, 10, 20000);
        camera.position.set(mapWidthWorld * 0.25, 4000, mapHeightWorld * 1.25);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        canvasContainer.appendChild(renderer.domElement);

        orbitControls = new OrbitControls(camera, renderer.domElement);
        orbitControls.target.set(mapWidthWorld / 2, 0, mapHeightWorld / 2);
        orbitControls.enableDamping = true;
        orbitControls.dampingFactor = 0.1;

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(-1, 2, 1).normalize();
        scene.add(directionalLight);
    }

    // // --- Replace your createTerrain function with this corrected version ---
    // async function createTerrain() {
    //     const textureUrl = `${MAP_API_URL}/texture-mq.jpg`;
    //     const heightmapUrl = `${MAP_API_URL}/height.png`;

    //     const textureLoader = new THREE.TextureLoader();
    //     const [colorTexture, heightmapTexture] = await Promise.all([
    //         textureLoader.loadAsync(textureUrl),
    //         textureLoader.loadAsync(heightmapUrl),
    //     ]);

    //     imageWidth = colorTexture.image.width;
    //     imageHeight = colorTexture.image.height;
    //     renderer.setSize(imageWidth, imageHeight);
    //     controlsDiv.style.width = `${imageWidth}px`;
    //     camera.aspect = imageWidth / imageHeight;
    //     camera.updateProjectionMatrix();

    //     // Get heightmap data into a pixel array
    //     const hmWidth = heightmapTexture.image.width;
    //     const hmHeight = heightmapTexture.image.height;
    //     const canvas = document.createElement('canvas');
    //     canvas.width = hmWidth;
    //     canvas.height = hmHeight;
    //     const ctx = canvas.getContext('2d', { willReadFrequently: true });
    //     ctx.drawImage(heightmapTexture.image, 0, 0);
    //     const pixelData = ctx.getImageData(0, 0, hmWidth, hmHeight).data;

    //     const geometry = new THREE.PlaneGeometry(mapWidthWorld, mapHeightWorld, 255, 255);

    //     const positions = geometry.attributes.position.array;
    //     const uvs = geometry.attributes.uv.array;
    //     baseHeightData = []; // Reset the array

    //     // Step 1: Get height for every vertex and store it
    //     for (let i = 0; i < positions.length / 3; i++) {
    //         const u = uvs[i * 2];
    //         const v = uvs[i * 2 + 1];

    //         // This mapping is now correct. The (1 - v) inverts the V coordinate
    //         // to match the image's top-to-bottom pixel order.
    //         const imgX = Math.floor(u * (hmWidth - 1));
    //         const imgY = Math.floor((1 - v) * (hmHeight - 1));

    //         const pixelIndex = (imgY * hmWidth + imgX) * 4;
    //         const grayscale = pixelData[pixelIndex] / 255.0;
    //         const height = grayscale * 800;

    //         positions[i * 3 + 1] = height; // Apply the height to the 3D model
    //         baseHeightData.push(height);   // Store the original height in our array
    //     }

    //     const material = new THREE.MeshStandardMaterial({ map: colorTexture });

    //     terrainMesh = new THREE.Mesh(geometry, material);
    //     terrainMesh.rotation.x = -Math.PI / 2;
    //     terrainMesh.position.set(mapWidthWorld / 2, 0, mapHeightWorld / 2);
    //     scene.add(terrainMesh);

    //     // After manually changing vertices, we must re-calculate normals for correct lighting
    //     terrainMesh.geometry.computeVertexNormals();
    // }

    async function createTerrain() {
        const textureUrl = `${MAP_API_URL}/texture-mq.jpg`;
        const heightmapUrl = `${MAP_API_URL}/height.png`;

        const textureLoader = new THREE.TextureLoader();
        const [colorTexture, heightmapTexture] = await Promise.all([
            textureLoader.loadAsync(textureUrl),
            textureLoader.loadAsync(heightmapUrl),
        ]);

        imageWidth = colorTexture.image.width;
        imageHeight = colorTexture.image.height;

        const container = document.getElementById("canvas-container");

        const width = container.clientWidth;
        const height = container.clientHeight;

        renderer.setSize(width, height);
        controlsDiv.style.width = `${imageWidth}px`;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();

        const observer = new ResizeObserver(entries => {
            const { width, height } = entries[0].contentRect;

            renderer.setSize(width, height);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        });

        observer.observe(container);

        // --- SETUP a canvas to be our dynamic heightmap source ---
        const hmWidth = heightmapTexture.image.width;
        const hmHeight = heightmapTexture.image.height;
        displacementCanvas = document.createElement('canvas');
        displacementCanvas.width = hmWidth;
        displacementCanvas.height = hmHeight;
        displacementContext = displacementCanvas.getContext('2d', { willReadFrequently: true });

        // Draw the initial heightmap image to our canvas
        displacementContext.drawImage(heightmapTexture.image, 0, 0);
        const initialImageData = displacementContext.getImageData(0, 0, hmWidth, hmHeight);

        // Save the original, unmodified pixel data
        baseHeightImageData = displacementContext.getImageData(0, 0, hmWidth, hmHeight);

        // Create a Three.js texture that USES our canvas as its source
        displacementTexture = new THREE.CanvasTexture(displacementCanvas);

        // --- <<< NEW: Create the high-precision base height data array ---
        baseHeightData = new Float32Array(hmWidth * hmHeight);
        for (let i = 0; i < baseHeightData.length; i++) {
            const pixelValue = initialImageData.data[i * 4]; // Read the red channel
            baseHeightData[i] = mapPixelToHeight(pixelValue);
        }
        // --- End of new section ---

        // Create the terrain using the GPU-accelerated displacementMap method
        const geometry = new THREE.PlaneGeometry(mapWidthWorld, mapHeightWorld, 255, 255);
        const material = new THREE.MeshStandardMaterial({
            map: colorTexture,
            // ** Step 1: Assign the texture property **
            displacementMap: displacementTexture,
            // ** Step 2: Adjust the scale **
            displacementScale: MAX_MAP_HEIGHT - MIN_MAP_HEIGHT,
        });

        terrainMesh = new THREE.Mesh(geometry, material);
        terrainMesh.rotation.x = -Math.PI / 2;
        // <<< CHANGED: The mesh base is positioned at the minimum height
        terrainMesh.position.set(mapWidthWorld / 2, MIN_MAP_HEIGHT, mapHeightWorld / 2);
        scene.add(terrainMesh);
    }

    /**
     * Creates the 3D mesh for the water plane and adds it to the scene.
     */
    function createWaterPlane() {
        const waterGeometry = new THREE.PlaneGeometry(mapWidthWorld, mapHeightWorld);

        const waterMaterial = new THREE.MeshStandardMaterial({
            color: 0x42a5f5,      // A nice blue color
            transparent: true,
            opacity: 0.60,
            roughness: 0.1,       // Makes the surface shiny like water
            metalness: 0.2
        });

        waterPlane = new THREE.Mesh(waterGeometry, waterMaterial);
        waterPlane.rotation.x = -Math.PI / 2; // Lay it flat
        waterPlane.position.x = mapWidthWorld / 2;          // Initial height
        waterPlane.position.z = mapHeightWorld / 2;          // Initial height
        waterPlane.position.y = 0;          // Initial height
        waterPlane.visible = true;           // Start visible

        scene.add(waterPlane);
    }

    // --- TERRAIN MUTATORS ---

    // <<< NEW: Helper function to map a real height to a 0-255 pixel value
    function mapHeightToPixel(height) {
        const normalized = (height - MIN_MAP_HEIGHT) / (MAX_MAP_HEIGHT - MIN_MAP_HEIGHT);
        return Math.max(0, Math.min(255, normalized * 255));
    }

    // <<< NEW: Helper function to map a pixel value back to a real height
    function mapPixelToHeight(pixelValue) {
        const normalized = pixelValue / 255;
        return normalized * (MAX_MAP_HEIGHT - MIN_MAP_HEIGHT) + MIN_MAP_HEIGHT;
    }

    /**
     * Creates a new ImageData object by modifying pixels from an input ImageData.
     * Pixels with a value greater than the threshold are multiplied by the factor.
     */
    // <<< CHANGED: This function now takes a real height threshold
    function applyExtremeAboveToPixels(sourceImageData, heightThreshold, factor) {
        const pixelThreshold = mapHeightToPixel(heightThreshold); // <<< CHANGED: Convert to pixel value
        const newImageData = new ImageData(sourceImageData.width, sourceImageData.height);
        const sourcePixels = sourceImageData.data;
        const newPixels = newImageData.data;

        for (let i = 0; i < sourcePixels.length; i += 4) {
            const heightValue = sourcePixels[i];
            const newHeight = (heightValue > pixelThreshold) ? Math.min(255, heightValue * factor) : heightValue;
            newPixels[i] = newPixels[i + 1] = newPixels[i + 2] = newHeight;
            newPixels[i + 3] = 255;
        }
        return newImageData;
    }

    /**
     * Creates a new ImageData object by modifying pixels from an input ImageData.
     * Pixels with a value less than the threshold are multiplied by the factor.
     */
    // <<< CHANGED: This function now takes a real height threshold
    function applyExtremeBelowToPixels(sourceImageData, heightThreshold, factor) {
        const pixelThreshold = mapHeightToPixel(heightThreshold); // <<< CHANGED: Convert to pixel value
        const newImageData = new ImageData(sourceImageData.width, sourceImageData.height);
        const sourcePixels = sourceImageData.data;
        const newPixels = newImageData.data;

        for (let i = 0; i < sourcePixels.length; i += 4) {
            const heightValue = sourcePixels[i];
            const newHeight = (heightValue < pixelThreshold) ? Math.min(255, heightValue * factor) : heightValue;
            newPixels[i] = newPixels[i + 1] = newPixels[i + 2] = newHeight;
            newPixels[i + 3] = 255;
        }
        return newImageData;
    }

    /**
     * Applies the full chain of mutators in order.
     */
    function applyMutatorChain() {
        if (!baseHeightData) return;

        // 1. Start with a fresh copy of the high-precision base terrain data.
        const mutatedHeightData = new Float32Array(baseHeightData);

        // 2. Sequentially apply each mutator in the chain to the real height data.
        //    This step is where heights can go far beyond the original min/max.
        for (const mutator of mutatorChain) {
            const absoluteThreshold = WATER_LEVEL + mutator.threshold;
            const delta = mutator.factor - 1;

            if (mutator.type === 'above') {
                for (let i = 0; i < mutatedHeightData.length; i++) {
                    const originalHeight = mutatedHeightData[i];
                    if (originalHeight > absoluteThreshold) {
                        const distance = originalHeight - absoluteThreshold;
                        mutatedHeightData[i] = originalHeight + (distance * delta);
                    }
                }
            } else if (mutator.type === 'below') {
                for (let i = 0; i < mutatedHeightData.length; i++) {
                    const originalHeight = mutatedHeightData[i];
                    if (originalHeight < absoluteThreshold) {
                        const distance = absoluteThreshold - originalHeight;
                        mutatedHeightData[i] = originalHeight - (distance * delta);
                    }
                }
            }
        }

        // 3. Find the NEW min and max heights from the mutated data.
        let newMinHeight = Infinity;
        let newMaxHeight = -Infinity;
        for (let i = 0; i < mutatedHeightData.length; i++) {
            if (mutatedHeightData[i] < newMinHeight) newMinHeight = mutatedHeightData[i];
            if (mutatedHeightData[i] > newMaxHeight) newMaxHeight = mutatedHeightData[i];
        }

        // Handle the case of a perfectly flat plane.
        if (newMinHeight === newMaxHeight) {
            newMaxHeight += 1.0; // Prevent division by zero
        }

        // 4. Update the terrain mesh's scale and position to match the new reality.
        terrainMesh.position.y = newMinHeight;
        terrainMesh.material.displacementScale = newMaxHeight - newMinHeight;

        // 5. Convert the final, mutated real-world heights back into a pixel-based image,
        //    NORMALIZED TO THE NEW MIN/MAX.
        const finalImageData = displacementContext.createImageData(displacementCanvas.width, displacementCanvas.height);
        const newRange = newMaxHeight - newMinHeight;

        for (let i = 0; i < mutatedHeightData.length; i++) {
            const height = mutatedHeightData[i];
            // Normalize the height within the new range [0, 1]
            const normalized = (height - newMinHeight) / newRange;
            // Convert to a 0-255 pixel value
            const pixelValue = Math.round(normalized * 255);

            finalImageData.data[i * 4] = pixelValue; // R
            finalImageData.data[i * 4 + 1] = pixelValue; // G
            finalImageData.data[i * 4 + 2] = pixelValue; // B
            finalImageData.data[i * 4 + 3] = 255;        // A
        }

        // 6. Update the canvas and signal to Three.js that the texture has changed.
        displacementContext.putImageData(finalImageData, 0, 0);
        displacementTexture.needsUpdate = true;
    }


    /**
     * Initializes the dynamic mutator UI and its event listeners.
     */
    function initializeMutatorControls() {
        const container = document.getElementById('mutator-controls-container');
        const addAboveBtn = document.getElementById('add-above-btn');
        const addBelowBtn = document.getElementById('add-below-btn');
        const resetTerrainBtn = document.getElementById('reset-terrain-btn');

        // Function to create the HTML for a new mutator row
        function createMutatorUI(mutator) {
            const div = document.createElement('div');
            div.className = 'control-group mutator-row';
            div.dataset.id = mutator.id; // Assign a unique ID

            const typeLabel = mutator.type === 'above' ? "Raise Above" : "Lower Below";

            div.innerHTML = `
                <label>${typeLabel}:</label>
                <input type="range" class="threshold-slider" min="${MIN_MAP_HEIGHT}" max="${MAX_MAP_HEIGHT}" value="${mutator.threshold}" step="1">
                <span class="mutator-value threshold-value">${mutator.threshold}</span>
                <label>Factor:</label>
                <input type="range" class="factor-slider" min="-10.0" max="10.0" value="${mutator.factor}" step="0.01">
                <span class="mutator-value factor-value">${mutator.factor.toFixed(2)}</span>
                <button class="remove-mutator-btn">X</button>
            `;
            return div;
        }

        // Function to add a new mutator to the state and UI
        function addMutator(type) {
            const newMutator = {
                id: Date.now(), // Simple unique ID
                type: type,
                // <<< CHANGED: Default thresholds are now the real min/max heights
                threshold: type === 'above' ? MAX_MAP_HEIGHT : MIN_MAP_HEIGHT,
                factor: 1.0
            };
            mutatorChain.push(newMutator);
            const mutatorElement = createMutatorUI(newMutator);
            container.appendChild(mutatorElement);
            applyMutatorChain();
        }

        addAboveBtn.addEventListener('click', () => addMutator('above'));
        addBelowBtn.addEventListener('click', () => addMutator('below'));

        // Reset terrain and clear all mutators
        resetTerrainBtn.addEventListener('click', () => {
            mutatorChain = [];
            container.innerHTML = '';
            applyMutatorChain(); // Re-applies the base image data
        });

        // Use event delegation to handle all input changes and removals
        container.addEventListener('input', (event) => {
            const target = event.target;
            if (target.matches('.threshold-slider, .factor-slider')) {
                const row = target.closest('.mutator-row');
                const id = parseInt(row.dataset.id);
                const mutator = mutatorChain.find(m => m.id === id);

                if (mutator) {
                    const thresholdSlider = row.querySelector('.threshold-slider');
                    const factorSlider = row.querySelector('.factor-slider');

                    mutator.threshold = parseFloat(thresholdSlider.value);
                    mutator.factor = parseFloat(factorSlider.value);

                    // Update UI text
                    row.querySelector('.threshold-value').textContent = mutator.threshold.toFixed(0);
                    row.querySelector('.factor-value').textContent = mutator.factor.toFixed(2);

                    applyMutatorChain();
                }
            }
        });

        container.addEventListener('click', (event) => {
            if (event.target.matches('.remove-mutator-btn')) {
                const row = event.target.closest('.mutator-row');
                const id = parseInt(row.dataset.id);

                // Remove from state and UI
                mutatorChain = mutatorChain.filter(m => m.id !== id);
                row.remove();

                applyMutatorChain();
            }
        });
    }

    /**
 * Sets up event listeners for the water level controls.
 */
    function initializeWaterControls() {
        const waterToggle = document.getElementById('water-toggle');
        const waterSlider = document.getElementById('water-level-slider');
        const waterDisplay = document.getElementById('water-level-display');

        // Set a dynamic range for the slider based on map height
        waterSlider.min = MIN_MAP_HEIGHT - 200; // Allow going below original min
        waterSlider.max = MAX_MAP_HEIGHT + 500; // Allow going well above original max
        waterSlider.value = 0; // Set initial value
        waterDisplay.textContent = waterSlider.value;

        // Toggle water visibility
        waterToggle.addEventListener('change', () => {
            waterPlane.visible = waterToggle.checked;
        });

        // Update water height from slider
        waterSlider.addEventListener('input', () => {
            const newHeight = parseFloat(waterSlider.value);
            waterPlane.position.y = newHeight;
            waterDisplay.textContent = newHeight.toFixed(0);
        });
    }

    // --- 3D OBJECTS & COORDINATE MAPPING ---
    function createUnitSprites() {
        const loader = new THREE.TextureLoader();
        for (const unitId in unitTimelines) {
            const unitInfo = unitTimelines[unitId];
            const def = unitDefinitions[unitInfo.uDefName];

            if (def && def.icon) {
                const texture = loader.load(def.icon);
                const material = new THREE.SpriteMaterial({ map: texture });
                const sprite = new THREE.Sprite(material);
                sprite.scale.set(60, 60, 1);
                sprite.visible = false;
                unitSprites[unitId] = sprite;
                scene.add(sprite);
            }
        }
    }

    function getHeightAt(x, z) {
        if (!heightDataContext) return 0;
        const u = x / mapWidthWorld;
        const v = (z / mapHeightWorld);
        const imageX = Math.floor(u * heightDataContext.canvas.width);
        const imageY = Math.floor(v * heightDataContext.canvas.height);
        const pixelData = heightDataContext.getImageData(imageX, imageY, 1, 1).data;
        const grayscale = pixelData[0] / 255.0;
        return grayscale * 800;
    }

    function worldTo3dPosition(x, y, z) {
        return new THREE.Vector3(x, y, z);
    }

    function getInterpolatedPosition(unitId, frame) {
        const timeline = unitTimelines[unitId]?.data;
        if (!timeline || timeline.length === 0) return null;
        let start = null, end = null;
        for (let i = 0; i < timeline.length; i++) {
            if (timeline[i].frame <= frame) start = timeline[i];
            if (timeline[i].frame >= frame && !end) end = timeline[i];
        }
        if (!start) return timeline[0];
        if (!end) return timeline[timeline.length - 1];
        if (start.frame === end.frame) return start;
        const progress = (frame - start.frame) / (end.frame - start.frame);

        const x = start.x + (end.x - start.x) * progress;
        const y = start.y + (end.y - start.y) * progress; // <-- THE NEW PART
        const z = start.z + (end.z - start.z) * progress;

        return { x, y, z }
    }

    // --- ANIMATION LOOP & FRAME UPDATING ---
    function startAnimationLoop() {
        function animate() {
            requestAnimationFrame(animate);
            // FIX #2: Animation logic is now inside the main animation loop
            if (isPlaying && currentFrame < maxFrame) {
                currentFrame++;
                updateFrame(currentFrame, false); // Pass false to not update slider from animation
            }
            orbitControls.update();
            renderer.render(scene, camera);
        }
        animate();
    }

    // updateSlider parameter prevents feedback loop
    function updateFrame(frame, updateSlider = true) {
        currentFrame = frame;
        if (updateSlider) {
            timeSlider.value = frame;
        }
        timeDisplay.textContent = `Frame ${frame} / ${(frame / FPS).toFixed(2)}s`;
        const selectedTeam = teamFilter.value;
        const selectedUnit = unitFilter.value;
        let visibleSpriteCount = 0;

        for (const unitId in unitSprites) {
            const sprite = unitSprites[unitId];
            const unitInfo = unitTimelines[unitId];
            const isVisible = (selectedTeam === 'all' || unitInfo.team_id === selectedTeam) &&
                (selectedUnit === 'all' || unitInfo.uDefName === selectedUnit) &&
                (frame >= unitInfo.data[0].frame);

            sprite.visible = false;
            if (isVisible) {
                const pos = getInterpolatedPosition(unitId, frame);
                if (pos) {
                    sprite.position.copy(worldTo3dPosition(pos.x, pos.y, pos.z));
                    // Tint the sprite material's color
                    sprite.material.color.setHex(TEAM_COLORS[unitInfo.team_id] || TEAM_COLORS.default);
                    sprite.visible = true;
                    visibleSpriteCount++;
                }
            }
        }
        spriteCountDisplay.textContent = visibleSpriteCount;
    }

    function addTestBoxes() {
        // Round map center to nearest integer x,z
        const centerX = Math.round(mapWidthWorld / 2);
        const centerZ = Math.round(mapHeightWorld / 2);
        const yPos = 0.5; // Since box height is 1, y=0.5 places it sitting on ground

        // Create red box at center
        const redGeometry = new THREE.BoxGeometry(1, 1, 1);
        const redMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
        const redBox = new THREE.Mesh(redGeometry, redMaterial);
        redBox.position.set(centerX, getHeightAt(centerX, centerZ), centerZ);
        scene.add(redBox);

        // Create blue box offset +1 x, +1 z
        const blueGeometry = new THREE.BoxGeometry(1, 1, 1);
        const blueMaterial = new THREE.MeshStandardMaterial({ color: 0x0000ff });
        const blueBox = new THREE.Mesh(blueGeometry, blueMaterial);
        blueBox.position.set(centerX + 1, getHeightAt(centerX, centerZ), centerZ + 1);
        scene.add(blueBox);
    }

    // --- UI CONTROLS ---
    function initializeUI() {
        const sortedUnitDefs = Object.keys(unitDefinitions).sort((a, b) =>
            unitDefinitions[a].name.localeCompare(unitDefinitions[b].name)
        );
        sortedUnitDefs.forEach(uDefName => {
            const friendlyName = unitDefinitions[uDefName].name || uDefName;
            unitFilter.add(new Option(friendlyName, uDefName));
        });

        const allTeamIds = new Set(Object.values(unitTimelines).map(t => t.team_id));
        const sortedTeams = Array.from(allTeamIds).sort((a, b) => a - b);
        sortedTeams.forEach(id => teamFilter.add(new Option(`Team ${id}`, id)));

        timeSlider.min = minFrame;
        timeSlider.max = maxFrame;
        timeSlider.value = minFrame;
        currentFrame = minFrame;

        playPauseBtn.addEventListener('click', togglePlayPause);
        resetBtn.addEventListener('click', resetAnimation);
        timeSlider.addEventListener('input', () => updateFrame(parseInt(timeSlider.value, 10), false));
        teamFilter.addEventListener('change', () => updateFrame(currentFrame));
        unitFilter.addEventListener('change', () => updateFrame(currentFrame));
    }

    function playAnimation() {
        if (currentFrame >= maxFrame) currentFrame = minFrame;
        isPlaying = true;
        playPauseBtn.textContent = 'Pause';
    }
    function pauseAnimation() {
        isPlaying = false;
        playPauseBtn.textContent = 'Play';
    }
    function togglePlayPause() { isPlaying ? pauseAnimation() : playAnimation(); }
    function resetAnimation() {
        pauseAnimation();
        updateFrame(minFrame);
    }

    // --- START ---
    loadAndPopulateMaps();
    initialize();
});