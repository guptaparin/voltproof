// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {GranularCertificate} from "./GranularCertificate.sol";

/// @title CertificateMarket
/// @notice Peer-to-peer market where small producers sell hourly certificates directly
///         to buyers. Listed Wh are held in escrow; buyers can take delivery or buy-and-retire
///         atomically, so a purchased Wh can be claimed in the same transaction.
contract CertificateMarket is ERC1155Holder, ReentrancyGuard {
    GranularCertificate public immutable certs;

    struct Listing {
        address seller;
        uint256 certificateId;
        uint256 remainingWh;
        uint256 priceWeiPerWh;
        bool active;
    }

    Listing[] private _listings;

    event Listed(uint256 indexed listingId, address indexed seller, uint256 indexed certificateId, uint256 amountWh, uint256 priceWeiPerWh);
    event Purchased(uint256 indexed listingId, address indexed buyer, uint256 amountWh, uint256 paidWei, bool retired);
    event Cancelled(uint256 indexed listingId);

    error NotSeller();
    error InactiveListing();
    error InsufficientSupply(uint256 available);
    error WrongPayment(uint256 expected);
    error ZeroAmount();
    error PayoutFailed();

    constructor(GranularCertificate certs_) {
        certs = certs_;
    }

    /// @dev Seller must first call certs.setApprovalForAll(market, true).
    function list(uint256 certificateId, uint256 amountWh, uint256 priceWeiPerWh) external returns (uint256 listingId) {
        if (amountWh == 0) revert ZeroAmount();
        certs.safeTransferFrom(msg.sender, address(this), certificateId, amountWh, "");
        listingId = _listings.length;
        _listings.push(Listing(msg.sender, certificateId, amountWh, priceWeiPerWh, true));
        emit Listed(listingId, msg.sender, certificateId, amountWh, priceWeiPerWh);
    }

    function cancel(uint256 listingId) external nonReentrant {
        Listing storage l = _listings[listingId];
        if (l.seller != msg.sender) revert NotSeller();
        if (!l.active) revert InactiveListing();
        l.active = false;
        uint256 amt = l.remainingWh;
        l.remainingWh = 0;
        certs.safeTransferFrom(address(this), msg.sender, l.certificateId, amt, "");
        emit Cancelled(listingId);
    }

    /// @param retireNow if true, the purchased Wh are retired immediately on behalf of the buyer.
    function buy(
        uint256 listingId,
        uint256 amountWh,
        bool retireNow,
        string calldata beneficiary,
        string calldata purpose
    ) external payable nonReentrant {
        Listing storage l = _listings[listingId];
        if (!l.active) revert InactiveListing();
        if (amountWh == 0) revert ZeroAmount();
        if (amountWh > l.remainingWh) revert InsufficientSupply(l.remainingWh);
        uint256 cost = amountWh * l.priceWeiPerWh;
        if (msg.value != cost) revert WrongPayment(cost);

        l.remainingWh -= amountWh;
        if (l.remainingWh == 0) l.active = false;

        if (retireNow) {
            certs.retire(l.certificateId, amountWh, msg.sender, beneficiary, purpose);
        } else {
            certs.safeTransferFrom(address(this), msg.sender, l.certificateId, amountWh, "");
        }

        (bool ok, ) = payable(l.seller).call{value: cost}("");
        if (!ok) revert PayoutFailed();
        emit Purchased(listingId, msg.sender, amountWh, cost, retireNow);
    }

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    function getListing(uint256 i) external view returns (Listing memory) {
        return _listings[i];
    }
}
