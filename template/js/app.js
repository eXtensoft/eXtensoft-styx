
        // Function to handle form submission
        function handleSubmit() {
            const inputText = document.getElementById("message-input").value;

            if (inputText.trim() !== "") {
                const selectedMessageType = document.querySelector('input[name="message-type"]:checked').value;
    
                //const messageType = config.messageTypes.find(type => type.name === selectedMessageType);
                Toaster.showToast(inputText,selectedMessageType);

                // Clear the input field after displaying the message
                document.getElementById("message-input").value = "";
            } else {
                // alert("Please enter a message before submitting.");
                Toaster.infoToast("Please enter a message before submitting.");
            }
        }

       function showToast(message) {
           
        const toasterContainer = document.getElementById(config.containerId);   
        const selectedMessageType = document.querySelector('input[name="message-type"]:checked').value;    
        const messageTypeConfig = config.messageTypes.find(type => type.name === selectedMessageType);
    
        if (!toasterContainer || !messageTypeConfig) {
            console.error(`Toaster container not found or invalid message type: '${selectedMessageType}'`);
            return;
        }
    }

    document.getElementById("message-input").addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
            event.preventDefault(); // Prevent the default Enter key behavior (e.g., line break)
            handleSubmit(); // Call the handleSubmit function
        }
    });
    
