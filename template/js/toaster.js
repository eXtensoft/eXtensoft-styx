const Toaster = (function() {
    // Default configuration values
    const config = {
        containerId: "toaster-container",
        fadeInDuration: 100,
        fadeOutDuration: 300,
        displayDuration: 5000,
        messageTypes: [
            {
                name: "info",
                icon: "ℹ️", // Info icon
                color: "darkgray", // Info color
            },
            {
                name: "warn",
                icon: "⚠️", // Warning icon
                color: "#f1c40f", // Warning color
            },
            {
                name: "error",
                icon: "❌", // Error icon
                color: "#e74c3c", // Error color
            },
            {
                name: "okay",
                icon: "✅", // Okay icon
                color: "#2ecc71", // Okay color
            },
        ],
    };

    // Queue to store pending messages
    const messageQueue = [];

    // Function to update the configuration
    function setConfig(options) {
        Object.assign(config, options);
    };

    function infoToast(message){
        showToast(message,"info");        
    };

    function warnToast(message){
        showToast(message,"warn");        
    };
    function errorToast(message){
        showToast(message,"error");        
    };
    function okayToast(message){
        showToast(message,"okay");        
    };

    // Function to display a toaster message
    function showToast(message, messageType = "info") {
        const toasterContainer = document.getElementById(config.containerId);

        const messageTypeConfig = config.messageTypes.find(type => type.name === messageType);

        if (!toasterContainer || !messageTypeConfig) {
            console.error(`Toaster container not found or invalid message type: '${messageType}'`);
            return;
        }

        const toast = document.createElement("div");
        toast.className = "toaster";
        toast.style.backgroundColor = messageTypeConfig.color;

        const icon = document.createElement("span");
        icon.className = "toaster-icon";
        icon.innerHTML = messageTypeConfig.icon;

        const messageText = document.createElement("span");
        messageText.textContent = message;

        toast.appendChild(icon);
        toast.appendChild(messageText);

        // Add the toast to the queue
        messageQueue.push(toast);

        if (messageQueue.length === 1) {
            // If there are no messages currently displayed, show the first one
            displayNextToast();
        }
        // Function to display the next toast in the queue
        function displayNextToast() {
            if (messageQueue.length > 0) {
                const nextToast = messageQueue[0];
                toasterContainer.appendChild(nextToast);

                setTimeout(function() {
                    nextToast.style.opacity = "1";
                }, config.fadeInDuration);

                setTimeout(function() {
                    nextToast.style.opacity = "0";
                    setTimeout(function() {
                        toasterContainer.removeChild(nextToast);
                        messageQueue.shift(); // Remove the displayed message from the queue
                        if (messageQueue.length > 0) {
                            // If there are more messages in the queue, display the next one
                            displayNextToast();
                        }
                    }, config.fadeOutDuration);
                }, config.displayDuration);
            }
        }
    };
    // Public methods and properties
    return {
        showToast: showToast,
        setConfig: setConfig,
        infoToast: infoToast,
        warnToast: warnToast,
        errorToast: errorToast,
        okayToast: okayToast
    };
})();
