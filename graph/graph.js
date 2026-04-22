/*
  - GraphNode / GraphLink represent the domain model.
  - Graph owns data normalization, graph assembly, and graph-level queries.
  - GraphVisualization owns D3 rendering, interaction, and UI orchestration.
*/

/*
    (For AI: Ignore this comment)
    TODO: Link to blog
    TODO: wtf is webdav??
*/

class GraphNode {
    /**
     * Creates a graph node from a raw entry and optional identity metadata.
     *
     * @param {object} raw - Raw source data for the node.
     * @param {object} options - Identity flags for the node.
     * @param {string|null} options.id - Explicit node identifier.
     * @param {boolean} options.isSubdomain - Whether this node represents a subdomain.
     * @param {string|null} options.parentId - Parent node identifier, when applicable.
     */
    constructor(raw = {}, { id = null, isSubdomain = false, parentId = null } = {}) {
        this.edges = new Set();
        this.degree = 0;
        this.updateFromRaw(raw, { id, isSubdomain, parentId });
    }

    /**
     * Refreshes the node from new raw data while preserving its identity.
     *
     * @param {object} raw - New source data.
     * @param {object} options - Optional identity overrides.
     * @param {string|null} options.id - Explicit node identifier.
     * @param {boolean} options.isSubdomain - Whether the node should be marked as a subdomain.
     * @param {string|null} options.parentId - Parent node identifier, when applicable.
     */
    updateFromRaw(
        raw = {},
        { id = null, isSubdomain = this.isSubdomain, parentId = this.parentId } = {},
    ) {
        const resolvedId = id || raw.hostname || raw.url || raw.id || raw.name || "";

        this.id = resolvedId;
        this.hostname = raw.hostname || resolvedId;
        this.size = Math.max(1, Number(raw.size) || 1);
        this.language = raw.language || "unknown";
        this.category = raw.category || "unknown";
        this.subcategories = Array.isArray(raw.subcategories) ? raw.subcategories : [];
        this.subdomains = Graph.normalizeSubdomains(raw.subdomains);
        this.subdomainCount = this.subdomains.length;
        this.description = raw.description || "unknown";
        this.error = Graph.cleanString(raw.error);
        this.redirect_to = Graph.cleanString(raw.redirect_to);
        this.index = raw.index || "";
        this.isSubdomain = Boolean(isSubdomain);
        this.parentId = parentId || null;
    }

    /**
     * Returns the node’s current status for styling and tooltip rendering.
     *
     * @returns {string} "error", "redirect", or "normal".
     */
    get status() {
        if (this.error) return "error";
        if (this.redirect_to) return "redirect";
        return "normal";
    }

    /**
     * Indicates whether the node has more than one subdomain.
     *
     * @returns {boolean} True when the subdomain count is greater than 1.
     */
    hasMultipleSubdomains() {
        return (this.subdomainCount || 0) > 0;
    }

    /**
     * Determines whether the node should be hidden by the sidebar rule.
     *
     * @param {boolean} hideEmptyNodes - Whether empty/error nodes are hidden.
     * @returns {boolean} True when the node should be hidden.
     */
    isHiddenBySidebarRule(hideEmptyNodes) {
        if (!hideEmptyNodes) return false;

        const desc = (this.description || "").trim().toLowerCase();

        return (
            this.error ||
            this.redirect_to ||
            desc === "" ||
            desc === "unknown" ||
            desc === "no description."
        );
    }
}

class GraphLink {
    /**
     * Creates a link between two node identifiers.
     *
     * @param {string} sourceId - Source node identifier.
     * @param {string} targetId - Target node identifier.
     * @param {number} count - Link weight or multiplicity.
     */
    constructor(sourceId, targetId, count = 1) {
        this.sourceId = sourceId;
        this.targetId = targetId;
        this.count = Math.max(1, Number(count) || 1);
    }
}

class Graph {
    /**
     * Creates an empty graph container.
     */
    constructor() {
        this.nodesMap = new Map();
        this.rawLinks = [];
        this.allLinks = [];
        this.edgeCountMap = {};
    }

    /**
     * Trims a string and returns null for empty or non-string values.
     * This is useful because some strings may have null values.
     *
     * @param {*} value - Value to clean.
     * @returns {string|null} Cleaned string or null.
     */
    static cleanString(value) {
        if (typeof value !== "string") return null;
        const s = value.trim();
        return s ? s : null;
    }

    /**
     * Normalizes subdomain entries into a uniform array of { id, label } objects.
     *
     * @param {*} raw - Raw subdomain input.
     * @returns {Array<{id: string, label: string}>} Normalized subdomain list.
     */
    static normalizeSubdomains(raw) {
        if (!Array.isArray(raw)) return [];

        return raw
            .map((item) => {
                if (typeof item === "string") {
                    const id = item.trim();
                    return id ? { id, label: id } : null;
                }

                if (item && typeof item === "object") {
                    const id = item.hostname || item.url || item.id || item.name;
                    if (!id) return null;
                    return {
                        id,
                        label: item.hostname || item.url || item.id || item.name || id,
                    };
                }

                return null;
            })
            .filter(Boolean);
    }

    /**
     * Builds the internal graph model from raw database data.
     *
     * This method populates node maps, resolves links, assigns degrees,
     * and prepares the data structures used by rendering and interaction.
     *
     * @param {Array|Object} rawData - Raw graph source data.
     * @returns {Graph} The current graph instance.
     */
build(rawData) {
    this.nodesMap = new Map();
    this.rawLinks = [];
    this.allLinks = [];
    this.edgeCountMap = {};

    const entries = Array.isArray(rawData) ? rawData : Object.values(rawData || {});
    const entryById = new Map();

    for (const entry of entries) {
        const id = entry.hostname || entry.url || entry.id || entry.name;
        if (id) entryById.set(id, entry);
    }

    const makeNode = (entry, id, isSubdomain = false, parentId = null) =>
        new GraphNode(entry, { id, isSubdomain, parentId });

    const upsertNode = (id, entry, isSubdomain = false, parentId = null) => {
        if (!this.nodesMap.has(id)) {
            this.nodesMap.set(id, makeNode(entry, id, isSubdomain, parentId));
            return;
        }

        const node = this.nodesMap.get(id);
        node.updateFromRaw(entry || {}, {
            id,
            isSubdomain: node.isSubdomain || isSubdomain,
            parentId,
        });

        if (isSubdomain) node.isSubdomain = true;
        if (parentId && !node.parentId) node.parentId = parentId;
    };

    const addOutgoingLinks = (entry, sourceId) => {
        const outgoing = Array.isArray(entry.links)
            ? entry.links
            : Array.isArray(entry.edges)
                ? entry.edges.map((hostname) => ({ hostname, links: 1 }))
                : [];

        for (const link of outgoing) {
        const targetId = link?.hostname || link?.url || link?.id;
        if (!targetId || targetId === sourceId) continue;
        if (!entryById.has(targetId)) continue; // skip if not a real entry

            const count = Math.max(1, Number(link?.links) || 1);

            upsertNode(
                targetId,
                entryById.get(targetId) || { hostname: targetId, links: [], subdomains: [] },
            );

            this.nodesMap.get(sourceId).edges.add(targetId);
            this.rawLinks.push(new GraphLink(sourceId, targetId, count));
        }
    };

    // Prevent processing the same real object twice, but still allow string placeholders
    const processedIds = new Set();

    const ingestEntry = (entry, { parentId = null, isSubdomain = false } = {}) => {
        if (!entry || typeof entry !== "object") return;

        const sourceId = entry.hostname || entry.url || entry.id || entry.name;
        if (!sourceId) return;

        upsertNode(sourceId, entry, isSubdomain, parentId);

        if (processedIds.has(sourceId)) return;
        processedIds.add(sourceId);

        // Process this node's own outgoing links
        addOutgoingLinks(entry, sourceId);

        // Process nested subdomains, including their own outgoing links
        const subdomains = Array.isArray(entry.subdomains) ? entry.subdomains : [];
        for (const sub of subdomains) {
            const childId =
                typeof sub === "string" ? sub : sub?.hostname || sub?.url || sub?.id;
            if (!childId) continue;

            const childEntry =
                typeof sub === "string"
                    ? { hostname: childId, links: [], subdomains: [] }
                    : sub;

            upsertNode(childId, childEntry, true, sourceId);
            this.nodesMap.get(sourceId).edges.add(childId);
            this.rawLinks.push(new GraphLink(sourceId, childId, 1));

            if (typeof sub === "object" && sub) {
                ingestEntry(childEntry, { parentId: sourceId, isSubdomain: true });
            }
        }
    };

    for (const entry of entries) {
        ingestEntry(entry);
    }

    // Merge duplicate links and compute degree / edge counts
    const linkMap = new Map();
    for (const link of this.rawLinks) {
        const key = `${link.sourceId}->${link.targetId}`;
        const existing = linkMap.get(key);
        if (existing) {
            existing.count += link.count;
        } else {
            linkMap.set(key, new GraphLink(link.sourceId, link.targetId, link.count));
        }
    }

    this.rawLinks = Array.from(linkMap.values());
    const outgoingTotals = new Map();
    this.edgeCountMap = {};

    for (const link of this.rawLinks) {
        outgoingTotals.set(link.sourceId, (outgoingTotals.get(link.sourceId) || 0) + link.count);
        this.edgeCountMap[`${link.sourceId}->${link.targetId}`] = link.count;
    }

    this.nodesMap.forEach((node) => {
        node.edges = Array.from(node.edges);
        node.degree = outgoingTotals.get(node.id) || 0;
    });

    this.allLinks = this.rawLinks
        .map((link) => ({
            source: this.nodesMap.get(link.sourceId),
            target: this.nodesMap.get(link.targetId),
            count: link.count,
        }))
        .filter((link) => link.source && link.target);

    return this;
}

    /**
     * Returns all nodes in the graph as an array.
     *
     * @returns {GraphNode[]} All graph nodes.
     */
    get allNodes() {
        return Array.from(this.nodesMap.values());
    }

    /**
     * Looks up a node by identifier.
     *
     * @param {string} id - Node identifier.
     * @returns {GraphNode|null} The matching node, or null when missing.
     */
    getNode(id) {
        return this.nodesMap.get(id) || null;
    }

    /**
     * Returns the node identifiers that belong to the current detail view.
     *
     * @param {string|null} detailRootId - Root node for detail mode.
     * @returns {Set<string>|null} Set of visible identifiers, or null in main view.
     */
    getCurrentViewIds(detailRootId) {
        if (!detailRootId) return null;

        const root = this.getNode(detailRootId);
        if (!root) return null;

        const ids = new Set([root.id]);
        const subs = Array.isArray(root.subdomains) ? root.subdomains : [];

        subs.forEach((s) => {
            const id = typeof s === "string" ? s : s?.id || s?.hostname || s?.url;
            if (id) ids.add(id);
        });

        return ids;
    }

    /**
     * Returns the nodes that belong to the current view mode.
     *
     * In main mode, subdomains are excluded.
     * In detail mode, only the root and its subdomains are returned.
     *
     * @param {string|null} detailRootId - Root node for detail mode.
     * @returns {GraphNode[]} Nodes visible in the current mode.
     */
    getCurrentModeNodes(detailRootId) {
        if (detailRootId) {
            const ids = this.getCurrentViewIds(detailRootId);
            return ids ? this.allNodes.filter((node) => ids.has(node.id)) : [];
        }

        return this.allNodes.filter((node) => !node.isSubdomain);
    }

    /**
     * Computes the visible graph after applying mode and sidebar filters.
     *
     * @param {object} state - Visualization state object.
     * @returns {{visibleNodes: GraphNode[], visibleLinks: object[], visibleLabels: GraphNode[]}}
     *          Filtered nodes, links, and labels.
     */
    getVisibleGraph(state) {
        const {
            nodeMinOutgoing,
            nodeMinSize,
            languageFilter,
            categoryFilter,
            subcategoryFilter,
            hideEmptyNodes,
        } = state.settings;

        const detailIds = this.getCurrentViewIds(state.detailRootId);

        let visibleNodes = this.allNodes.filter((node) => {
            if (detailIds) {
                if (!detailIds.has(node.id)) return false;
            } else if (node.isSubdomain) {
                return false;
            }

            const subcats = Array.isArray(node.subcategories) ? node.subcategories : [];

            const matchesLanguage = !languageFilter || node.language === languageFilter;
            const matchesCategory = !categoryFilter || node.category === categoryFilter;
            const matchesSubcategory = !subcategoryFilter || subcats.includes(subcategoryFilter);
            const matchesDegree = node.degree >= nodeMinOutgoing;
            const matchesSize = node.size >= nodeMinSize;
            const passesEmptyRule = !hideEmptyNodes || !node.isHiddenBySidebarRule(true);

            return (
                matchesLanguage &&
                matchesCategory &&
                matchesSubcategory &&
                matchesDegree &&
                matchesSize &&
                passesEmptyRule
            );
        });

        if (state.focusedNodeId && !detailIds) {
            const focusedNode = this.getNode(state.focusedNodeId);
            if (focusedNode) {
                visibleNodes.push(focusedNode);
                focusedNode.edges.forEach((id) => {
                    const n = this.getNode(id);
                    if (n) visibleNodes.push(n);
                });
            }
        }

        const visibleIdSet = new Set(visibleNodes.map((n) => n.id));
        visibleNodes = Array.from(visibleIdSet).map((id) => this.getNode(id)).filter(Boolean);

        const visibleLinks = this.allLinks.filter(
            (link) => visibleIdSet.has(link.source.id) && visibleIdSet.has(link.target.id),
        );

        const visibleLabels = visibleNodes.filter(
            (node) => node.degree >= state.settings.labelMinOutgoing,
        );

        return { visibleNodes, visibleLinks, visibleLabels };
    }

    /**
     * Counts values for language, category, and subcategory facets.
     *
     * @param {GraphNode[]} nodes - Nodes to analyze.
     * @returns {object} Facet count maps for the supplied nodes.
     */
    computeFacetCounts(nodes) {
        const count = (arr) => {
            const map = new Map();
            arr.forEach((v) => {
                const key = (v || "").trim();
                if (!key) return;
                map.set(key, (map.get(key) || 0) + 1);
            });
            return map;
        };

        return {
            languageCounts: count(nodes.map((n) => n.language)),
            categoryCounts: count(nodes.map((n) => n.category)),
            subcategoryCounts: count(
                nodes.flatMap((n) => (Array.isArray(n.subcategories) ? n.subcategories : [])),
            ),
        };
    }

    /**
     * Counts repeated string values in an array.
     *
     * @param {Array<string>} values - Values to count.
     * @returns {Map<string, number>} Occurrence map.
     */
    countOccurrences(values) {
        const map = new Map();
        values.forEach((v) => {
            const key = (v || "").trim();
            if (!key) return;
            map.set(key, (map.get(key) || 0) + 1);
        });
        return map;
    }

    /**
     * Computes the outgoing highlight set for a given node.
     *
     * Only outgoing neighbors and their connecting links are included.
     *
     * @param {string} nodeId - Node identifier to highlight.
     * @returns {{nodes: Set<string>, links: Set<object>}} Highlighted node and link sets.
     */
    computeHighlight(nodeId) {
        const nodes = new Set([nodeId]);
        const links = new Set();

        this.allLinks.forEach((link) => {
            if (link.source.id === nodeId) {
                nodes.add(link.target.id);
                links.add(link);
            }
        });

        return { nodes, links };
    }

    /**
     * Returns the outgoing neighbor identifiers for a node.
     *
     * @param {GraphNode} node - Node whose neighbors should be collected.
     * @returns {Set<string>} Outgoing neighbor identifiers.
     */
    getNeighbors(node) {
        const neighbors = new Set();
        this.allLinks.forEach((link) => {
            if (link.source.id === node.id) neighbors.add(link.target.id);
        });
        return neighbors;
    }
}

class GraphVisualization {
    /**
     * Creates the visualization controller and binds the SVG/UI handles.
     *
     * @param {object} options - Visualization configuration.
     * @param {string} options.svgSelector - CSS selector for the SVG root.
     * @param {string} options.tooltipSelector - CSS selector for the tooltip element.
     * @param {string} options.dataUrl - URL to the graph data source.
     */
    constructor({
        svgSelector = "svg",
        tooltipSelector = ".tooltip",
        dataUrl = "database.json",
    } = {}) {
        this.svg = d3.select(svgSelector);
        this.tooltip = d3.select(tooltipSelector);
        this.dataUrl = dataUrl;

        this.width = window.innerWidth;
        this.height = window.innerHeight;

        this.container = this.svg.append("g");

        this.zoomBehavior = null;
        this.graph = new Graph();

        this.visibleNodes = [];
        this.visibleLinks = [];
        this.visibleLabels = [];

        this.highlightedNodeId = null;
        this.focusedNodeId = null;
        this.simulation = null;

        this.linkSelection = null;
        this.nodeSelection = null;
        this.labelSelection = null;

        this.radiusScale = null;
        this.colorScale = null;
        this.edgeOpacityScale = null;

        this.state = {
            detailRootId: null,
            subdomainMode: false,
            focusedHostname: null,
            highlightSubdomainNodes: false,
            settings: {
                labelMinOutgoing: 10,
                nodeMinOutgoing: 0,
                nodeMinSize: 1,
                languageFilter: "",
                categoryFilter: "",
                subcategoryFilter: "",
                searchQuery: "",
                hideEmptyNodes: true,
            },
        };

        this.controls = {
            searchInput: null,
            searchResults: null,
            labelMinOutgoing: null,
            nodeMinOutgoing: null,
            nodeMinSize: null,
            languageFilter: null,
            categoryFilter: null,
            subcategoryFilter: null,
            hideEmptyNodes: null,
            highlightSubdomainNodes: null,
            returnButton: null,
            subdomainBar: null,
            subdomainTitle: null,
            subdomainClose: null,
        };
    }

    /**
     * Initializes zooming, controls, data loading, and the first render.
     *
     * @returns {Promise<void>} Resolves after the graph has been rendered.
     */
    async init() {
        this.setupZoom();
        this.setupBackgroundClick();
        this.bindControls();

        const rawData = await d3.json(this.dataUrl);
        this.graph.build(rawData);
        this.createScales();
        this.applyFiltersAndRender();
    }

    /**
     * Configures pan/zoom behavior on the SVG root.
     */
    setupZoom() {
        this.zoomBehavior = d3
            .zoom()
            .scaleExtent([0.1, 5])
            .on("zoom", (event) => {
                this.container.attr("transform", event.transform);
            });

        this.svg.call(this.zoomBehavior);
    }

    /**
     * Resets focus and highlight state when the background is clicked.
     */
    setupBackgroundClick() {
        this.svg.on("click", () => {
            this.focusedNodeId = null;
            this.highlightedNodeId = null;
            this.restoreDefaultStyles?.();
        });
    }

    /**
     * Binds DOM controls to the visualization state and event handlers.
     */
    bindControls() {
        this.controls.searchInput = document.getElementById("hostnameSearch");
        this.controls.searchResults = document.getElementById("searchResults");
        this.controls.labelMinOutgoing = document.getElementById("labelMinOutgoing");
        this.controls.nodeMinOutgoing = document.getElementById("nodeMinOutgoing");
        this.controls.nodeMinSize = document.getElementById("nodeMinSize");
        this.controls.languageFilter = document.getElementById("languageFilter");
        this.controls.categoryFilter = document.getElementById("categoryFilter");
        this.controls.subcategoryFilter = document.getElementById("subcategoryFilter");
        this.controls.hideEmptyNodes = document.getElementById("hideEmptyNodes");
        this.controls.returnButton = document.getElementById("returnButton");
        this.controls.subdomainBar = document.getElementById("subdomainBar");
        this.controls.subdomainTitle = document.getElementById("subdomainTitle");
        this.controls.subdomainClose = document.getElementById("subdomainClose");
        this.controls.highlightSubdomainNodes = document.getElementById("highlightSubdomainNodes");

        this.controls.subdomainClose?.addEventListener("click", () => {
            this.exitSubdomainMode();
        });

        this.controls.searchInput?.addEventListener("input", () => {
            this.state.settings.searchQuery = this.controls.searchInput.value;
            this.renderSearchResults(this.state.settings.searchQuery);
        });

        this.controls.labelMinOutgoing?.addEventListener("change", () => {
            this.state.settings.labelMinOutgoing = this.toInt(
                this.controls.labelMinOutgoing.value,
                0,
            );
            this.applyFiltersAndRender();
        });

        this.controls.nodeMinOutgoing?.addEventListener("change", () => {
            this.state.settings.nodeMinOutgoing = this.toInt(
                this.controls.nodeMinOutgoing.value,
                0,
            );
            this.applyFiltersAndRender();
        });

        this.controls.nodeMinSize?.addEventListener("change", () => {
            this.state.settings.nodeMinSize = this.toInt(this.controls.nodeMinSize.value, 1);
            this.applyFiltersAndRender();
        });

        const updateFilters = () => {
            this.applyFiltersAndRender();
            this.populateFilterOptions();
        };

        this.controls.languageFilter?.addEventListener("change", () => {
            this.state.settings.languageFilter = this.controls.languageFilter.value;
            updateFilters();
        });

        this.controls.categoryFilter?.addEventListener("change", () => {
            this.state.settings.categoryFilter = this.controls.categoryFilter.value;
            updateFilters();
        });

        this.controls.subcategoryFilter?.addEventListener("change", () => {
            this.state.settings.subcategoryFilter = this.controls.subcategoryFilter.value;
            updateFilters();
        });

        this.controls.hideEmptyNodes?.addEventListener("change", () => {
            this.state.settings.hideEmptyNodes = this.controls.hideEmptyNodes.checked;
            updateFilters();
        });

        this.controls.highlightSubdomainNodes?.addEventListener("change", () => {
            this.state.highlightSubdomainNodes = this.controls.highlightSubdomainNodes.checked;

            if (this.state.highlightSubdomainNodes) {
                this.applySubdomainHighlights();
            } else {
                this.restoreDefaultStyles();
            }
        });

        if (this.controls.returnButton) {
            this.controls.returnButton.addEventListener("click", () => {
                this.state.subdomainMode = false;
                this.state.detailRootId = null;
                this.state.focusedHostname = null;
                this.focusedNodeId = null;
                this.highlightedNodeId = null;

                this.applyFiltersAndRender();
                this.populateFilterOptions();

                this.controls.returnButton.style.display = "none";
            });
        }

        this.renderSearchResults("");
    }

    /**
     * Switches the visualization into subdomain mode for a hostname.
     *
     * @param {string} hostname - Hostname to focus on.
     */
    enterSubdomainMode(hostname) {
        this.state.subdomainMode = true;
        this.state.focusedHostname = hostname;

        if (this.controls.subdomainBar) {
            this.controls.subdomainBar.style.display = "block";
        }
        if (this.controls.subdomainTitle) {
            this.controls.subdomainTitle.textContent = `Subdomains of ${hostname}`;
        }

        this.applyFiltersAndRender();
        this.populateFilterOptions();
    }

    /**
     * Leaves subdomain mode and restores the main graph view.
     */
    exitSubdomainMode() {
        this.state.subdomainMode = false;
        this.state.detailRootId = null;
        this.state.focusedHostname = null;
        this.focusedNodeId = null;
        this.highlightedNodeId = null;

        if (this.controls.subdomainBar) {
            this.controls.subdomainBar.style.display = "none";
        }

        this.applyFiltersAndRender();
        this.populateFilterOptions();

        if (this.zoomBehavior) {
            this.svg
                .transition()
                .duration(450)
                .call(this.zoomBehavior.transform, d3.zoomIdentity);
        }
    }

    /**
     * Opens the detail view for a specific node.
     *
     * @param {string} nodeId - Node identifier to focus on.
     */
enterDetailView(nodeId) {
    this.state.detailRootId = nodeId;
    this.state.subdomainMode = true;
    this.state.focusedHostname = nodeId;
    this.focusedNodeId = nodeId;
    this.highlightedNodeId = null;

    if (this.controls.subdomainBar) {
        this.controls.subdomainBar.style.display = "block";
    }
    if (this.controls.subdomainTitle) {
        this.controls.subdomainTitle.textContent = `Subdomains of ${nodeId}`;
    }

    this.tooltip.style("opacity", 0);
    this.applyFiltersAndRender();

    const node = this.visibleNodes.find((d) => d.id === nodeId);
    if (node) {
        this.applyHighlight(node);
    }
}

    /**
     * Exits detail view and restores the default graph state.
     */
    exitDetailView() {
        this.state.detailRootId = null;
        this.focusedNodeId = null;
        this.highlightedNodeId = null;
        this.applyFiltersAndRender();
        this.restoreDefaultStyles();
    }

applySubdomainHighlights() {
    if (!this.nodeSelection || !this.linkSelection || !this.labelSelection) return;

    const isSubdomainNode = (d) => (d.subdomainCount || 0) > 0;

    this.linkSelection
        .attr("stroke", "#2f3440")
        .attr("stroke-width", 1)
        .attr("stroke-opacity", 0.08);

    this.nodeSelection
        .attr("opacity", (d) => (isSubdomainNode(d) ? 1 : 0.08));

    this.labelSelection
        .attr("opacity", (d) => (isSubdomainNode(d) ? 1 : 0.05));
}
    /**
     * Converts a string input into an integer with fallback support.
     *
     * @param {string} value - Input string.
     * @param {number} fallback - Value used when parsing fails.
     * @returns {number} Parsed integer or fallback.
     */
    toInt(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    /**
     * Filters nodes using the current sidebar state.
     *
     * @param {string|null} excludeKey - Optional facet key to ignore.
     * @param {GraphNode[]} baseNodes - Input node set.
     * @returns {GraphNode[]} Filtered nodes.
     */
    getFilteredNodes(excludeKey = null, baseNodes = this.getCurrentModeNodes()) {
        const {
            languageFilter,
            categoryFilter,
            subcategoryFilter,
            nodeMinOutgoing,
            nodeMinSize,
            hideEmptyNodes,
        } = this.state.settings;

        return baseNodes.filter((node) => {
            const subcats = Array.isArray(node.subcategories) ? node.subcategories : [];

            const matchesLanguage =
                excludeKey === "language" || !languageFilter || node.language === languageFilter;
            const matchesCategory =
                excludeKey === "category" || !categoryFilter || node.category === categoryFilter;
            const matchesSubcategory =
                excludeKey === "subcategory" || !subcategoryFilter || subcats.includes(subcategoryFilter);
            const matchesDegree = node.degree >= nodeMinOutgoing;
            const matchesSize = node.size >= nodeMinSize;
            const matchesEmptyRule = !hideEmptyNodes || !node.error;

            return (
                matchesLanguage &&
                matchesCategory &&
                matchesSubcategory &&
                matchesDegree &&
                matchesSize &&
                matchesEmptyRule
            );
        });
    }

    /**
     * Computes facet counts for a given node set.
     *
     * @param {GraphNode[]} nodes - Nodes to count.
     * @returns {object} Facet count maps.
     */
    computeFacetCounts(nodes) {
        return this.graph.computeFacetCounts(nodes);
    }

    /**
     * Rebuilds the sidebar dropdown options from the current visible nodes.
     */
    populateFilterOptions() {
const baseNodes = (this.visibleNodes.length ? this.visibleNodes : this.getCurrentModeNodes())
    .filter(node =>
        !this.state.settings.hideEmptyNodes || !node.isHiddenBySidebarRule(true)
    );
        const { languageCounts, categoryCounts, subcategoryCounts } = this.computeFacetCounts(baseNodes);

        const fill = (select, counts, allLabel) => {
            if (!select) return;

            const current = select.value || "";
            const values = [...counts.keys()].sort((a, b) => a.localeCompare(b));
            const total = [...counts.values()].reduce((a, b) => a + b, 0);

            select.innerHTML = `
                <option value="">${allLabel} (${this.formatNumber(total)})</option>
                ${values
                    .map(
                        (v) => `
                    <option value="${this.escapeHtml(v)}">
                        ${this.escapeHtml(v)} (${this.formatNumber(counts.get(v) || 0)})
                    </option>
                `,
                    )
                    .join("")}
            `;

            select.value = current;
        };

        fill(this.controls.languageFilter, languageCounts, "All languages");
        fill(this.controls.categoryFilter, categoryCounts, "All categories");
        fill(this.controls.subcategoryFilter, subcategoryCounts, "All subcategories");
    }

    /**
     * Formats a tooltip HTML fragment for a node.
     *
     * @param {GraphNode} node - Node to describe.
     * @returns {string} Tooltip HTML markup.
     */
    formatTooltip(node) {
        const language = node.language || "unknown";
        const category = node.category || "uncategorized";
        const subs = Array.isArray(node.subcategories) ? node.subcategories : [];
        const description = node.description || "No description.";
        const error = node.error || "";
        const redirectTo = node.redirect_to || "";
        const isSubdomain = !!node.isSubdomain;

        const statusBlock = error
            ? `
        <div class="tooltip__status tooltip__status--error">
          <span class="tooltip__label">Error</span>
          <div class="tooltip__status-text">${this.escapeHtml(error)}</div>
        </div>
      `
            : redirectTo
                ? `
        <div class="tooltip__status tooltip__status--redirect">
          <span class="tooltip__label">Redirect</span>
          <div class="tooltip__status-text">${this.escapeHtml(redirectTo)}</div>
        </div>
      `
                : `
        <div class="tooltip__description">
          ${this.escapeHtml(description)}
        </div>
      `;

const statsBlock = `
  <div class="tooltip__meta tooltip__stats">
    <div class="tooltip__stat">
      <span class="tooltip__label">Outgoing</span>
      <span class="tooltip__value">${this.formatNumber(node.degree)}</span>
    </div>

    <div class="tooltip__stat">
      <span class="tooltip__label">Size</span>
      <span class="tooltip__value">${this.formatNumber(node.size)}</span>
    </div>

    ${
      !isSubdomain && (node.subdomainCount || 0) > 0
        ? `
          <div class="tooltip__stat tooltip__stat--subdomains">
            <span class="tooltip__label">SUBDOMAINS</span>
            <span class="tooltip__value">${this.formatNumber(node.subdomainCount)}</span>
          </div>
        `
        : ""
    }
  </div>
`;

        return `
          <div class="tooltip__title">${this.escapeHtml(node.id)}</div>

          ${statsBlock}

          ${statusBlock}

          <div class="tooltip__meta tooltip__meta--language">
            <span class="tooltip__label">Language</span>
            <span class="tooltip__language">${this.escapeHtml(language)}</span>
          </div>

          <div class="tooltip__meta">
            <span class="tooltip__label">Category</span>
            <div class="tooltip__tags">
              <span class="tooltip__tag tooltip__tag--category">${this.escapeHtml(category)}</span>
              ${
                  subs.length
                      ? subs
                            .map((tag) => `<span class="tooltip__tag">${this.escapeHtml(tag)}</span>`)
                            .join("")
                      : ""
              }
            </div>
          </div>
        `;
    }

    /**
     * Returns the nodes in the current view mode.
     *
     * @returns {GraphNode[]} Current-mode nodes.
     */
    getCurrentModeNodes() {
        return this.graph.getCurrentModeNodes(this.state.detailRootId);
    }

    /**
     * Returns the identifiers visible in the current detail view.
     *
     * @returns {Set<string>|null} Visible identifiers, or null in main mode.
     */
    getCurrentViewIds() {
        return this.graph.getCurrentViewIds(this.state.detailRootId);
    }

    /**
     * Rebuilds the internal graph model from raw data.
     *
     * @param {Array|Object} rawData - Source data.
     */
    buildGraph(rawData) {
        this.graph.build(rawData);
    }

    /**
     * Performs a case-insensitive substring search.
     *
     * @param {string} value - Text to search.
     * @param {string} query - Search term.
     * @returns {boolean} True when the query matches the value.
     */
    matchesQuery(value, query) {
        const v = String(value || "").trim().toLowerCase();
        const q = String(query || "").trim().toLowerCase();
        return !q || v.includes(q);
    }

    /**
     * Returns the semantic status for a node.
     *
     * @param {GraphNode} node - Node to inspect.
     * @returns {string} Node status.
     */
    getNodeStatus(node) {
        return node?.status || "normal";
    }

    /**
     * Computes the display radius for a node.
     *
     * @param {GraphNode} node - Node to size.
     * @returns {number} Visual radius.
     */
    getNodeRadius(node) {
        const base = this.radiusScale(node.size);

        if (this.state.subdomainMode && this.state.detailRootId) {
            if (node.id === this.state.detailRootId) return base * 1.35;
            return base * 1.25;
        }

        return base;
    }

    /**
     * Computes the fill color for a node.
     *
     * @param {GraphNode} node - Node to color.
     * @returns {string} Fill color.
     */
    getNodeFill(node) {
        const status = this.getNodeStatus(node);

        if (status === "error") return "#e45757";
        if (status === "redirect") return "#f0a23a";

        return this.colorScale(Math.log10((node.degree || 0) + 1));
    }

    /**
     * Computes the stroke color for a node.
     *
     * @param {GraphNode} node - Node to outline.
     * @returns {string} Stroke color.
     */
    getNodeStroke(node) {
        return (node?.subdomainCount || 0) > 0 ? "#463191" : "none";
    }

    /**
     * Computes the stroke width for a node.
     *
     * @param {GraphNode} node - Node to outline.
     * @returns {number} Stroke width.
     */
    getNodeStrokeWidth(node) {
        return (node?.subdomainCount || 0) > 0 ? 2.5 : 0;
    }

    /**
     * Creates D3 scales for radius, color, and edge opacity.
     */
createScales() {
    const maxSize = d3.max(this.graph.allNodes, (d) => d.size) || 1;
    const maxDegree = d3.max(this.graph.allNodes, (d) => d.degree) || 1;
    const maxEdgeCount = d3.max(Object.values(this.graph.edgeCountMap)) || 1;

    const subdomainDegrees = this.graph.allNodes
        .filter((d) => d.isSubdomain)
        .map((d) => d.degree || 0);

    const maxSubdomainDegree = d3.max(subdomainDegrees) || 1;
    const minSubdomainDegree = d3.min(subdomainDegrees) || 0;

    this.radiusScale = d3.scaleLog().domain([1, maxSize]).range([4, 35]).clamp(true);

    // keep hostname coloring exactly the same
    this.colorScale = d3
        .scaleSequential(d3.interpolateBlues)
        .domain([Math.log10(maxDegree + 1), 0]);

    // separate scale only for subdomains
    this.subdomainColorScale = d3
        .scaleSequential(d3.interpolateBlues)
        .domain([Math.log10(maxSubdomainDegree + 1), Math.log10(minSubdomainDegree + 1)]);

    this.edgeOpacityScale = d3.scaleLinear().domain([1, maxEdgeCount]).range([0.1, 0.8]);
}

    /**
     * Returns the visible graph slice for the current application state.
     *
     * @returns {{visibleNodes: GraphNode[], visibleLinks: object[], visibleLabels: GraphNode[]}}
     *          Filtered graph data.
     */
    getVisibleGraph() {
        return this.graph.getVisibleGraph(this.state);
    }

    /**
     * Applies filters, rebuilds the SVG contents, and rerenders the graph.
     */
    applyFiltersAndRender() {
        const previouslyHighlightedId = this.highlightedNodeId || null;

        const { visibleNodes, visibleLinks, visibleLabels } = this.getVisibleGraph();

        this.visibleNodes = visibleNodes;
        this.visibleLinks = visibleLinks;
        this.visibleLabels = visibleLabels;

        if (this.simulation) {
            this.simulation.stop();
        }

        this.container.selectAll("*").remove();

        this.render();
        this.createSimulation();
        this.attachTickHandler();

        if (previouslyHighlightedId) {
            const node = this.visibleNodes.find((d) => d.id === previouslyHighlightedId);
            if (node) {
                this.applyHighlight(node);
            } else {
                this.highlightedNodeId = null;
            }
        }

        if (this.state.highlightSubdomainNodes) {
            this.applySubdomainHighlights();
        }

        this.populateFilterOptions(this.visibleNodes);
        this.renderSearchResults(this.state.settings.searchQuery, this.visibleNodes);
    }

    /**
     * Computes the effective width available for the graph layout.
     *
     * @returns {number} Available layout width.
     */
    getGraphWidth() {
        const sidebar = document.querySelector(".sidebar");
        const sidebarWidth = sidebar ? sidebar.offsetWidth : 0;
        return window.innerWidth - sidebarWidth;
    }

    /**
     * Creates the D3 force simulation for the current visible graph.
     */
    createSimulation() {
 const isDetail = this.state.subdomainMode && this.state.detailRootId;
const detailNodeCount = isDetail ? this.visibleNodes.length : 0;
const repulsion = isDetail ? -110 * Math.max(1, detailNodeCount / 10) : -400;
const linkDistance = isDetail ? Math.max(18, detailNodeCount * 0.5) : 50;

this.simulation = d3
    .forceSimulation(this.visibleNodes)
    .alpha(1)
    .alphaMin(isDetail ? 0.03 : 0.02)
    .alphaDecay(isDetail ? 0.09 : 0.12)
    .velocityDecay(isDetail ? 0.45 : 0.5)
    .force(
        "link",
        d3
            .forceLink(this.visibleLinks)
            .id((d) => d.id)
            .distance((d) => {
                if (isDetail) {
                    return d.source.id === this.state.detailRootId || d.target.id === this.state.detailRootId
                        ? linkDistance
                        : linkDistance * 1.5;
                }
                return 50 + this.radiusScale(d.source.size);
            })
            .strength((d) => {
                if (isDetail) {
                    return d.source.id === this.state.detailRootId || d.target.id === this.state.detailRootId
                        ? 1
                        : 0.4;
                }
                return 0.04;
            }),
    )
    .force("charge", d3.forceManyBody().strength(repulsion))
    .force("center", d3.forceCenter(this.getGraphWidth() / 2, this.height / 2))
    .force(
        "collision",
        d3
            .forceCollide()
            .radius((d) => this.getNodeRadius(d) + (isDetail ? 3 : 6))
            .strength(1)
            .iterations(6),
    );

    this.simulation.on("end", () => {
    if (this.focusedNodeId) {
        const node = this.visibleNodes.find((d) => d.id === this.focusedNodeId);
        if (node) this.centerOnNode(node);
    }
});
    }

    /**
     * Renders links, nodes, and labels into the SVG container.
     */
    render() {
        this.renderLinks();
        this.renderNodes();
        this.renderLabels();
    }

    /**
     * Renders the visible link set.
     */
    renderLinks() {
        this.linkSelection = this.container
            .append("g")
            .attr("class", "links")
            .selectAll("line")
            .data(this.visibleLinks)
            .join("line")
            .attr("stroke", "#3b404a")
            .attr("stroke-width", (d) => Math.max(1, Math.log10((d.count || 1) + 1) + 0.5))
            .attr("stroke-opacity", (d) => this.edgeOpacityScale(d.count || 1))
            .on("mouseover", (event, d) => {
                this.tooltip
                    .style("opacity", 1)
                    .html(`${d.source.id} → ${d.target.id}<br/>Links: ${this.formatNumber(d.count || 1)}`);
            })
            .on("mousemove", (event) => {
                const rect = this.svg.node().getBoundingClientRect();
                this.tooltip
                    .style("left", `${event.clientX - rect.left + 10}px`)
                    .style("top", `${event.clientY - rect.top + 10}px`);
            })
            .on("mouseout", () => this.tooltip.style("opacity", 0));
    }

    /**
     * Renders the visible node set.
     */
    renderNodes() {
        this.nodeSelection = this.container
            .append("g")
            .attr("class", "nodes")
            .selectAll("circle")
            .data(this.visibleNodes)
            .join("circle")
            .attr("r", (d) => this.getNodeRadius(d))
            .attr("fill", (d) => this.getNodeFill(d))
            .attr("stroke", (d) => this.getNodeStroke(d))
            .attr("stroke-width", (d) => this.getNodeStrokeWidth(d))
            .attr("paint-order", "stroke")
            .style("cursor", (d) => (d.subdomainCount > 0 ? "pointer" : "default"))
            .on("mouseover", (event, d) => {
                this.tooltip.style("opacity", 1).html(this.formatTooltip(d));
            })
            .on("mousemove", (event) => {
                this.tooltip
                    .style("left", `${event.clientX + 14}px`)
                    .style("top", `${event.clientY + 14}px`);
            })
            .on("mouseout", () => this.tooltip.style("opacity", 0))
            .on("click", (event, clickedNode) => {
                event.stopPropagation();

                if (this.highlightedNodeId === clickedNode.id) {
                    this.highlightedNodeId = null;
                    this.restoreDefaultStyles();
                } else {
                    this.applyHighlight(clickedNode);
                }
            })
        .on("dblclick", (event, clickedNode) => {
            event.stopPropagation();
            event.preventDefault();

            const subCount = Array.isArray(clickedNode.subdomains) ? clickedNode.subdomains.length : 0;

            if (subCount > 0) {
                this.tooltip.style("opacity", 0);
                this.enterDetailView(clickedNode.id);
            }
        });
    }

    /**
     * Renders the visible node labels.
     */
    renderLabels() {
        this.labelSelection = this.container
            .append("g")
            .attr("class", "labels")
            .selectAll("text")
            .data(this.visibleLabels)
            .join("text")
            .text((d) => d.id)
            .attr("class", "label");
    }

    /**
     * Formats a numeric value for display.
     *
     * @param {number} value - Number to format.
     * @returns {string} Localized string representation.
     */
    formatNumber(value) {
        if (value == null || !Number.isFinite(value)) return "0";
        return new Intl.NumberFormat("en-EN").format(value);
    }

    /**
     * Computes the highlight set for a clicked node.
     *
     * @param {GraphNode} clickedNode - Node to highlight from.
     * @returns {{nodes: Set<string>, links: Set<object>}} Highlight set.
     */
    computeHighlight(clickedNode) {
        return this.graph.computeHighlight(clickedNode.id);
    }

    /**
     * Applies highlight styling for a selected node.
     *
     * @param {GraphNode} clickedNode - Node to highlight.
     */
    applyHighlight(clickedNode) {
        this.highlightedNodeId = clickedNode.id;

        const { nodes: visibleNodes, links: visibleLinks } = this.computeHighlight(clickedNode);

        this.linkSelection
            .attr("stroke", "#2f3440")
            .attr("stroke-width", 1)
            .attr("stroke-opacity", 0.08);

        this.linkSelection
            .filter((d) => visibleLinks.has(d))
            .attr("stroke", "#ffffff")
            .attr("stroke-width", 2.5)
            .attr("stroke-opacity", 0.9);

        this.nodeSelection.attr("opacity", 0.15);
        this.nodeSelection.filter((d) => visibleNodes.has(d.id)).attr("opacity", 1);

        this.labelSelection.attr("opacity", 0);
        this.labelSelection
            .filter((d) => visibleNodes.has(d.id))
            .attr("opacity", 1)
            .raise();
    }

    /**
     * Restores default styles for nodes, links, and labels.
     */
    restoreDefaultStyles() {
        if (!this.linkSelection || !this.nodeSelection || !this.labelSelection) return;

        this.linkSelection
            .attr("stroke", "#3b404a")
            .attr("stroke-width", (d) => Math.max(1, Math.log10((d.count || 1) + 1) + 0.5))
            .attr("stroke-opacity", (d) => this.edgeOpacityScale(d.count || 1));

        this.nodeSelection
            .attr("opacity", 1)
            .attr("fill", (d) => this.getNodeFill(d))
            .attr("stroke", (d) => this.getNodeStroke(d))
            .attr("stroke-width", (d) => this.getNodeStrokeWidth(d))
            .attr("paint-order", "stroke");

        this.labelSelection.attr("opacity", 1);
    }

    /**
     * Centers the viewport on a node using the current zoom behavior.
     *
     * @param {GraphNode} node - Node to center on.
     */
    centerOnNode(node) {
        if (!node || node.x == null || node.y == null || !this.zoomBehavior) return;

        const scale = 1.2;
        const transform = d3
            .zoomIdentity
            .translate(this.width / 2 - node.x * scale, this.height / 2 - node.y * scale)
            .scale(scale);

        this.svg.transition().duration(500).call(this.zoomBehavior.transform, transform);
    }

    /**
     * Renders the searchable node list and wires item clicks.
     *
     * @param {string} query - Search query string.
     * @param {GraphNode[]} sourceNodes - Node set to search within.
     */
    renderSearchResults(query, sourceNodes = this.graph.getCurrentModeNodes()) {
        if (!this.controls.searchResults) return;

        const q = (query || "").trim().toLowerCase();
        const hideEmptyNodes = this.state.settings.hideEmptyNodes;

        let matches = sourceNodes.filter((node) => {
            if (hideEmptyNodes && !this.state.detailRootId) {
                const hasStatus = Boolean(node.error || node.redirect_to);
                const desc = (node.description || "").trim().toLowerCase();
                if (!hasStatus && (!desc || desc === "unknown" || desc === "no description.")) {
                    return false;
                }
            }

            return node.id.toLowerCase().includes(q);
        });

        matches = matches.slice(0, 20);

        if (!matches.length) {
            this.controls.searchResults.innerHTML = '<div class="search-empty">No matches</div>';
            return;
        }

        this.controls.searchResults.innerHTML = matches
            .map(
                (node) => `
                    <button type="button" class="search-item" data-node="${this.escapeHtml(node.id)}">
                        ${this.escapeHtml(node.id)}
                    </button>
                `,
            )
            .join("");

        this.controls.searchResults.querySelectorAll(".search-item").forEach((button) => {
            button.addEventListener("click", () => {
                this.selectNodeById(button.dataset.node);
            });
        });
    }

    /**
     * Selects a node by identifier from the search UI.
     *
     * @param {string} nodeId - Node identifier to select.
     */
    selectNodeById(nodeId) {
        const node = this.graph.getNode(nodeId);
        if (!node) return;

        if (this.controls.searchInput) {
            this.controls.searchInput.value = nodeId;
        }
        this.state.settings.searchQuery = nodeId;
        this.focusedNodeId = nodeId;

        this.applyHighlight(node);
        this.centerOnNode(node);
    }

    /**
     * Escapes a string for safe HTML insertion.
     *
     * @param {*} value - Value to escape.
     * @returns {string} HTML-escaped string.
     */
    escapeHtml(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
    }

    /**
     * Updates link, node, and label positions on each simulation tick.
     */
    attachTickHandler() {
        if (!this.simulation) return;

        this.simulation.on("tick", () => {
            this.linkSelection
                .attr("x1", (d) => d.source.x)
                .attr("y1", (d) => d.source.y)
                .attr("x2", (d) => d.target.x)
                .attr("y2", (d) => d.target.y);

            this.nodeSelection.attr("cx", (d) => d.x).attr("cy", (d) => d.y);

            this.labelSelection
                .attr("x", (d) => d.x + this.getNodeRadius(d) + 5)
                .attr("y", (d) => d.y + 4);
        });
    }

    /**
     * Creates a D3 drag behavior for force-simulated nodes.
     *
     * @param {d3.Simulation} simulation - Active force simulation.
     * @returns {d3.DragBehavior} Drag behavior.
     */
    drag(simulation) {
        return d3
            .drag()
            .on("start", (event, d) => {
                if (!event.active) simulation.alphaTarget(0.3).restart();
                d.fx = d.x;
                d.fy = d.y;
            })
            .on("drag", (event, d) => {
                d.fx = event.x;
                d.fy = event.y;
            })
            .on("end", (event, d) => {
                if (!event.active) simulation.alphaTarget(0);
                d.fx = null;
                d.fy = null;
            });
    }
}

/**
 * Initializes the intro modal and its dismissal behavior.
 *
 * @returns {{show: Function, hide: Function}|undefined} Modal controls, when available.
 */
function initIntroModal() {
    const introModal = document.getElementById("introModal");
    const closeIntroModal = document.getElementById("closeIntroModal");
    const dismissIntroModal = document.getElementById("dismissIntroModal");

    if (!introModal) return;

    function hideIntroModal() {
        introModal.setAttribute("aria-hidden", "true");
        localStorage.setItem("introModalSeen", "true");
    }

    function showIntroModal() {
        introModal.setAttribute("aria-hidden", "false");
    }

    if (localStorage.getItem("introModalSeen") === "true") {
        hideIntroModal();
    } else {
        showIntroModal();
    }

    closeIntroModal?.addEventListener("click", hideIntroModal);
    dismissIntroModal?.addEventListener("click", hideIntroModal);

    introModal.addEventListener("click", (event) => {
        if (event.target === introModal || event.target.classList.contains("intro-modal__backdrop")) {
            hideIntroModal();
        }
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && introModal.getAttribute("aria-hidden") !== "true") {
            hideIntroModal();
        }
    });

    return {
        show: showIntroModal,
        hide: hideIntroModal,
    };
}

document.addEventListener("DOMContentLoaded", () => {
    const graph = new GraphVisualization({
        svgSelector: "svg",
        tooltipSelector: ".tooltip",
        dataUrl: "database.json",
    });

    initIntroModal();
    graph.init();
});
