/* eslint-disable require-jsdoc */
var hp = require("../support/helper.js");

// [CLY]_action interactions (fixtures/interactions.html): frustration signals from track_clicks
// (rage, dead and error clicks), track_inputs (fields changed and forms sent, without their
// values) and track_scrolls' scroll stops. They feed Session Replay's timelines and studies, and
// heatmaps; test_mode keeps them in the SDK's queues, where the tests read them.

function openPage() {
    hp.haltAndClearStorage(() => {
        cy.visit("./cypress/fixtures/interactions.html");
    });
    cy.window().its("Countly.app_key").should("equal", hp.appKey);
}

/**
 * The [CLY]_action segments the SDK queued, from its event queue and the requests it built from it
 * @returns {Cypress.Chainable<Array>} segmentations, in the order recorded
 */
function actions() {
    return cy.fetch_local_request_queue().then((rq) => {
        var out = [];
        rq.filter((r) => r.events).forEach((r) => {
            JSON.parse(r.events).forEach((e) => {
                if (e.key === "[CLY]_action") {
                    out.push(e.segmentation);
                }
            });
        });
        return cy.fetch_local_event_queue().then((eq) => out.concat(eq.filter((e) => e.key === "[CLY]_action").map((e) => e.segmentation)));
    });
}

const ofType = (list, type) => list.filter((a) => a.type === type);

describe("Interactions: frustration signals, inputs and scroll stops", () => {
    beforeEach(() => {
        // the failing button's error is for the SDK to notice, not a failure of the test
        cy.on("uncaught:exception", () => false);
    });

    it("three quick clicks on one spot are one rage click, besides the click itself", () => {
        openPage();
        cy.get("#works").click().click().click().click();
        cy.wait(1500);
        actions().then((list) => {
            var rage = ofType(list, "rage_click");
            expect(rage).to.have.length(1);
            expect(rage[0]).to.include({ sel: "button#works", tag: "button", txt: "Save" });
            expect(rage[0].x).to.be.a("number");
            expect(rage[0].y).to.be.a("number");
            // a click a second, and the button changed the page, so it was not dead
            expect(ofType(list, "click")).to.have.length(1);
            expect(ofType(list, "dead_click")).to.have.length(0);
        });
    });

    it("a click on a button that changes nothing is a dead click, and one that changes the page is not", () => {
        openPage();
        cy.get("#dead").click();
        cy.wait(1100);
        cy.get("#works").click();
        cy.wait(1500);
        actions().then((list) => {
            var dead = ofType(list, "dead_click");
            expect(dead).to.have.length(1);
            expect(dead[0]).to.include({ sel: "button#dead", tag: "button", txt: "Does nothing" });
            expect(ofType(list, "click").map((a) => a.sel)).to.deep.equal(["button#dead", "button#works"]);
        });
    });

    it("a click followed by a JavaScript error is an error click, not a dead one", () => {
        openPage();
        cy.get("#throws").click();
        cy.wait(1500);
        actions().then((list) => {
            var error = ofType(list, "error_click");
            expect(error).to.have.length(1);
            expect(error[0]).to.include({ sel: "button#throws", txt: "Breaks" });
            expect(ofType(list, "dead_click")).to.have.length(0);
        });
    });

    it("a changed field and a sent form are recorded without what was typed", () => {
        openPage();
        cy.get("#name").type("Ada Lovelace").blur();
        cy.get("#secret").type("hunter2").blur();
        cy.get("#send").click();
        cy.wait(800);
        actions().then((list) => {
            var inputs = ofType(list, "input");
            expect(inputs.map((a) => [a.sel, a.form, a.itype])).to.deep.equal([
                ["input#name", "form#signup", "text"],
                ["input#secret", "form#signup", "password"],
            ]);
            inputs.forEach((a) => {
                expect(a.tag).to.equal("input");
            });
            // the form's selector, though a field named "id" shadows the form's id property
            var submit = ofType(list, "submit");
            expect(submit).to.have.length(1);
            expect(submit[0]).to.include({ sel: "form#signup", tag: "form", form: "form#signup" });
            expect(submit[0]).not.to.have.property("itype");
            // nothing typed leaves the page
            expect(JSON.stringify(list)).not.to.contain("Ada Lovelace");
            expect(JSON.stringify(list)).not.to.contain("hunter2");
        });
    });

    it("a field names its form and its type, also from outside the form, and a field in no form names none", () => {
        openPage();
        cy.get("#nickname").type("Ada").blur();
        cy.get("#email").type("ada@example.com").blur();
        cy.get("#plan").select("pro");
        cy.get("#terms").check();
        cy.get("#note").type("Hello").blur();
        cy.get("#search").type("pricing").blur();
        cy.get("form.newsletter").submit();
        cy.wait(800);
        actions().then((list) => {
            var inputs = ofType(list, "input");
            expect(inputs.map((a) => [a.sel, a.form, a.itype])).to.deep.equal([
                ["input#nickname", "form#signup", "text"],
                ["input#email", "body > form.newsletter", "email"],
                ["select#plan", "body > form.newsletter", "select-one"],
                ["input#terms", "body > form.newsletter", "checkbox"],
                ["textarea#note", "body > form.newsletter", "textarea"],
                ["input#search", undefined, "search"],
            ]);
            expect(inputs[5]).not.to.have.property("form");
            // a form without an id is named the way any element is (up to three levels)
            var submit = ofType(list, "submit");
            expect(submit).to.have.length(1);
            expect(submit[0]).to.include({ sel: "body > form.newsletter", form: "body > form.newsletter" });
            expect(JSON.stringify(list)).not.to.contain("ada@example.com");
            expect(JSON.stringify(list)).not.to.contain("pricing");
        });
    });

    it("scrolling a quarter of the screen or more is one scroll stop where it settles, and a nudge is none", () => {
        openPage();
        cy.window().then((win) => {
            win.scrollTo(0, 20);
        });
        cy.wait(800);
        cy.window().then((win) => {
            win.scrollTo(0, 1500);
        });
        cy.wait(800);
        cy.window().then((win) => {
            actions().then((list) => {
                var stops = ofType(list, "scroll_stop");
                expect(stops).to.have.length(1);
                expect(stops[0].sy).to.equal(1500);
                // the bottom of what was on screen
                expect(stops[0].y).to.equal(1500 + win.innerHeight);
                expect(stops[0].height).to.be.above(4000);
            });
        });
    });
});
